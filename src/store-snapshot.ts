import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { withTransaction } from './sql-utils.js';
import type { SqlDatabaseLike } from './store-types.js';
import { normalizeWorktreeKey } from './worktree-key.js';

export type SnapshotScope = 'session' | 'root' | 'worktree' | 'all';

export type SnapshotWorktreeMode = 'auto' | 'preserve' | 'current';

export type SessionRow = {
  session_id: string;
  title: string | null;
  session_directory: string | null;
  worktree_key: string | null;
  parent_session_id: string | null;
  root_session_id: string | null;
  lineage_depth: number | null;
  pinned: number | null;
  pin_reason: string | null;
  updated_at: number;
  compacted_at: number | null;
  deleted: number;
  event_count: number;
};

export type MessageRow = {
  message_id: string;
  session_id: string;
  created_at: number;
  info_json: string;
};

export type PartRow = {
  part_id: string;
  session_id: string;
  message_id: string;
  sort_key: number;
  part_json: string;
};

export type SummaryNodeRow = {
  node_id: string;
  session_id: string;
  level: number;
  node_kind: string;
  start_index: number;
  end_index: number;
  message_ids_json: string;
  summary_text: string;
  created_at: number;
};

export type SummaryEdgeRow = {
  session_id: string;
  parent_id: string;
  child_id: string;
  child_position: number;
};

export type SummaryStateRow = {
  session_id: string;
  archived_count: number;
  latest_message_created: number;
  archived_signature: string | null;
  root_node_ids_json: string;
  updated_at: number;
};

export type ArtifactRow = {
  artifact_id: string;
  session_id: string;
  message_id: string;
  part_id: string;
  artifact_kind: string;
  field_name: string;
  preview_text: string;
  content_text: string;
  content_hash: string | null;
  metadata_json: string;
  char_count: number;
  created_at: number;
};

export type ArtifactBlobRow = {
  content_hash: string;
  content_text: string;
  char_count: number;
  created_at: number;
};

export type SnapshotPayload = {
  version: 1;
  exportedAt: number;
  scope: string;
  sessions: SessionRow[];
  messages: MessageRow[];
  parts: PartRow[];
  resumes: Array<{ session_id: string; note: string; updated_at: number }>;
  artifacts: ArtifactRow[];
  artifact_blobs: ArtifactBlobRow[];
  summary_nodes: SummaryNodeRow[];
  summary_edges: SummaryEdgeRow[];
  summary_state: SummaryStateRow[];
};

export type ExportSnapshotInput = {
  filePath: string;
  sessionID?: string;
  scope?: string;
};

export type ImportSnapshotInput = {
  filePath: string;
  mode?: 'replace' | 'merge';
  worktreeMode?: SnapshotWorktreeMode;
};

export type SnapshotExportBindings = {
  workspaceDirectory: string;
  normalizeScope(scope?: string): SnapshotScope | undefined;
  resolveScopeSessionIDs(scope?: string, sessionID?: string): string[] | undefined;
  readScopedSessionRowsSync(sessionIDs?: string[]): SessionRow[];
  readScopedMessageRowsSync(sessionIDs?: string[]): MessageRow[];
  readScopedPartRowsSync(sessionIDs?: string[]): PartRow[];
  readScopedResumeRowsSync(
    sessionIDs?: string[],
  ): Array<{ session_id: string; note: string; updated_at: number }>;
  readScopedArtifactRowsSync(sessionIDs?: string[]): ArtifactRow[];
  readScopedArtifactBlobRowsSync(sessionIDs?: string[]): ArtifactBlobRow[];
  readScopedSummaryRowsSync(sessionIDs?: string[]): SummaryNodeRow[];
  readScopedSummaryEdgeRowsSync(sessionIDs?: string[]): SummaryEdgeRow[];
  readScopedSummaryStateRowsSync(sessionIDs?: string[]): SummaryStateRow[];
};

export type SnapshotImportBindings = {
  workspaceDirectory: string;
  getDb(): SqlDatabaseLike;
  clearSessionDataSync(sessionID: string): void;
  backfillArtifactBlobsSync(): void;
  refreshAllLineageSync(): void;
  syncAllDerivedSessionStateSync(force: boolean): void;
  rebuildSearchIndexesSync(): void;
};

type SqlStatementLike = {
  run(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown;
};

export async function exportStoreSnapshot(
  bindings: SnapshotExportBindings,
  input: ExportSnapshotInput,
): Promise<string> {
  const scope = bindings.normalizeScope(input.scope) ?? 'session';
  const sessionIDs = bindings.resolveScopeSessionIDs(scope, input.sessionID);
  const sessions = bindings.readScopedSessionRowsSync(sessionIDs);
  const snapshot: SnapshotPayload = {
    version: 1,
    exportedAt: Date.now(),
    scope,
    sessions,
    messages: bindings.readScopedMessageRowsSync(sessionIDs),
    parts: bindings.readScopedPartRowsSync(sessionIDs),
    resumes: bindings.readScopedResumeRowsSync(sessionIDs),
    artifacts: bindings.readScopedArtifactRowsSync(sessionIDs),
    artifact_blobs: bindings.readScopedArtifactBlobRowsSync(sessionIDs),
    summary_nodes: bindings.readScopedSummaryRowsSync(sessionIDs),
    summary_edges: bindings.readScopedSummaryEdgeRowsSync(sessionIDs),
    summary_state: bindings.readScopedSummaryStateRowsSync(sessionIDs),
  };

  const targetPath = path.resolve(input.filePath);
  await writeFile(targetPath, JSON.stringify(snapshot, null, 2), 'utf8');
  return [
    `file=${targetPath}`,
    `scope=${scope}`,
    `sessions=${snapshot.sessions.length}`,
    `worktrees=${listSnapshotWorktreeKeys(sessions).length}`,
    `messages=${snapshot.messages.length}`,
    `parts=${snapshot.parts.length}`,
    `artifacts=${snapshot.artifacts.length}`,
    `artifact_blobs=${snapshot.artifact_blobs.length}`,
    `summary_nodes=${snapshot.summary_nodes.length}`,
  ].join('\n');
}

export async function importStoreSnapshot(
  bindings: SnapshotImportBindings,
  input: ImportSnapshotInput,
): Promise<string> {
  const sourcePath = path.resolve(input.filePath);
  const snapshot = parseSnapshotPayload(await readFile(sourcePath, 'utf8'));
  const db = bindings.getDb();
  const sessionIDs = [...new Set(snapshot.sessions.map((row) => row.session_id))];
  const worktreeMode = resolveSnapshotWorktreeMode(input.worktreeMode);
  const collisionSessionIDs = input.mode === 'merge' ? readExistingSessionIDs(db, sessionIDs) : [];
  if (collisionSessionIDs.length > 0) {
    throw new Error(
      `Snapshot merge would overwrite existing sessions: ${collisionSessionIDs.slice(0, 5).join(', ')}. Re-run with mode=replace or import a snapshot without those session IDs.`,
    );
  }

  const sourceWorktreeKeys = listSnapshotWorktreeKeys(snapshot.sessions);
  const targetWorktreeKey = normalizeWorktreeKey(bindings.workspaceDirectory);
  const shouldRehome = shouldRehomeImportedSessions(
    sourceWorktreeKeys,
    targetWorktreeKey,
    worktreeMode,
  );
  const importedSessions = shouldRehome
    ? snapshot.sessions.map((row) =>
        rehomeImportedSessionRow(row, bindings.workspaceDirectory, targetWorktreeKey),
      )
    : snapshot.sessions;

  withTransaction(db, 'importSnapshot', () => {
    if (input.mode !== 'merge') {
      for (const sessionID of sessionIDs) bindings.clearSessionDataSync(sessionID);
    }

    const insertSession = db.prepare(
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
    );
    const insertMessage = db.prepare(
      `INSERT OR REPLACE INTO messages (message_id, session_id, created_at, info_json) VALUES (?, ?, ?, ?)`,
    );
    const insertPart = db.prepare(
      `INSERT OR REPLACE INTO parts (part_id, session_id, message_id, sort_key, part_json) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertResume = db.prepare(
      `INSERT OR REPLACE INTO resumes (session_id, note, updated_at) VALUES (?, ?, ?)`,
    );
    const insertBlob = db.prepare(
      `INSERT OR REPLACE INTO artifact_blobs (content_hash, content_text, char_count, created_at) VALUES (?, ?, ?, ?)`,
    );
    const insertArtifact = db.prepare(
      `INSERT OR REPLACE INTO artifacts (artifact_id, session_id, message_id, part_id, artifact_kind, field_name, preview_text, content_text, content_hash, metadata_json, char_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertNode = db.prepare(
      `INSERT OR REPLACE INTO summary_nodes (node_id, session_id, level, node_kind, start_index, end_index, message_ids_json, summary_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEdge = db.prepare(
      `INSERT OR REPLACE INTO summary_edges (session_id, parent_id, child_id, child_position) VALUES (?, ?, ?, ?)`,
    );
    const insertState = db.prepare(
      `INSERT OR REPLACE INTO summary_state (session_id, archived_count, latest_message_created, archived_signature, root_node_ids_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const row of importedSessions) {
      insertSession.run(
        row.session_id,
        row.title,
        row.session_directory,
        row.worktree_key,
        row.parent_session_id,
        row.root_session_id,
        row.lineage_depth,
        row.pinned ?? 0,
        row.pin_reason,
        row.updated_at,
        row.compacted_at,
        row.deleted,
        row.event_count,
      );
    }
    for (const row of snapshot.messages)
      insertMessage.run(row.message_id, row.session_id, row.created_at, row.info_json);
    for (const row of snapshot.parts)
      insertPart.run(row.part_id, row.session_id, row.message_id, row.sort_key, row.part_json);
    for (const row of snapshot.resumes) insertResume.run(row.session_id, row.note, row.updated_at);
    for (const row of snapshot.artifact_blobs)
      insertBlob.run(row.content_hash, row.content_text, row.char_count, row.created_at);
    for (const row of snapshot.artifacts) {
      insertArtifact.run(
        row.artifact_id,
        row.session_id,
        row.message_id,
        row.part_id,
        row.artifact_kind,
        row.field_name,
        row.preview_text,
        row.content_text,
        row.content_hash,
        row.metadata_json,
        row.char_count,
        row.created_at,
      );
    }
    for (const row of snapshot.summary_nodes) {
      insertNode.run(
        row.node_id,
        row.session_id,
        row.level,
        row.node_kind,
        row.start_index,
        row.end_index,
        row.message_ids_json,
        row.summary_text,
        row.created_at,
      );
    }
    for (const row of snapshot.summary_edges)
      insertEdge.run(row.session_id, row.parent_id, row.child_id, row.child_position);
    for (const row of snapshot.summary_state) {
      insertState.run(
        row.session_id,
        row.archived_count,
        row.latest_message_created,
        row.archived_signature ?? '',
        row.root_node_ids_json,
        row.updated_at,
      );
    }
  });

  bindings.backfillArtifactBlobsSync();
  bindings.refreshAllLineageSync();
  bindings.syncAllDerivedSessionStateSync(true);
  bindings.rebuildSearchIndexesSync();
  return [
    `file=${sourcePath}`,
    `mode=${input.mode ?? 'replace'}`,
    `worktree_mode=${worktreeMode}`,
    `effective_worktree_mode=${shouldRehome ? 'current' : 'preserve'}`,
    `sessions=${snapshot.sessions.length}`,
    `source_worktrees=${sourceWorktreeKeys.length}`,
    `rehomed_sessions=${shouldRehome ? importedSessions.length : 0}`,
    `messages=${snapshot.messages.length}`,
    `parts=${snapshot.parts.length}`,
    `artifacts=${snapshot.artifacts.length}`,
    `artifact_blobs=${snapshot.artifact_blobs.length}`,
    `summary_nodes=${snapshot.summary_nodes.length}`,
  ].join('\n');
}

function parseSnapshotPayload(content: string): SnapshotPayload {
  const value = JSON.parse(content) as unknown;
  const record = expectRecord(value, 'Snapshot file');
  const version = record.version;
  if (version !== 1) {
    throw new Error(`Unsupported snapshot version: ${String(version)}`);
  }

  return {
    version: 1,
    exportedAt: expectNumber(record.exportedAt, 'exportedAt'),
    scope: expectString(record.scope, 'scope'),
    sessions: expectArray(record.sessions, 'sessions', parseSessionRow),
    messages: expectArray(record.messages, 'messages', parseMessageRow),
    parts: expectArray(record.parts, 'parts', parsePartRow),
    resumes: expectArray(record.resumes, 'resumes', parseResumeRow),
    artifacts: expectArray(record.artifacts, 'artifacts', parseArtifactRow),
    artifact_blobs: expectArray(record.artifact_blobs, 'artifact_blobs', parseArtifactBlobRow),
    summary_nodes: expectArray(record.summary_nodes, 'summary_nodes', parseSummaryNodeRow),
    summary_edges: expectArray(record.summary_edges, 'summary_edges', parseSummaryEdgeRow),
    summary_state: expectArray(record.summary_state, 'summary_state', parseSummaryStateRow),
  };
}

function parseSessionRow(value: unknown): SessionRow {
  const row = expectRecord(value, 'sessions[]');
  return {
    session_id: expectString(row.session_id, 'sessions[].session_id'),
    title: expectNullableString(row.title, 'sessions[].title'),
    session_directory: expectNullableString(row.session_directory, 'sessions[].session_directory'),
    worktree_key: expectNullableString(row.worktree_key, 'sessions[].worktree_key'),
    parent_session_id: expectNullableString(row.parent_session_id, 'sessions[].parent_session_id'),
    root_session_id: expectNullableString(row.root_session_id, 'sessions[].root_session_id'),
    lineage_depth: expectNullableNumber(row.lineage_depth, 'sessions[].lineage_depth'),
    pinned: expectNullableNumber(row.pinned, 'sessions[].pinned'),
    pin_reason: expectNullableString(row.pin_reason, 'sessions[].pin_reason'),
    updated_at: expectNumber(row.updated_at, 'sessions[].updated_at'),
    compacted_at: expectNullableNumber(row.compacted_at, 'sessions[].compacted_at'),
    deleted: expectNumber(row.deleted, 'sessions[].deleted'),
    event_count: expectNumber(row.event_count, 'sessions[].event_count'),
  };
}

function parseMessageRow(value: unknown): MessageRow {
  const row = expectRecord(value, 'messages[]');
  return {
    message_id: expectString(row.message_id, 'messages[].message_id'),
    session_id: expectString(row.session_id, 'messages[].session_id'),
    created_at: expectNumber(row.created_at, 'messages[].created_at'),
    info_json: expectString(row.info_json, 'messages[].info_json'),
  };
}

function parsePartRow(value: unknown): PartRow {
  const row = expectRecord(value, 'parts[]');
  return {
    part_id: expectString(row.part_id, 'parts[].part_id'),
    session_id: expectString(row.session_id, 'parts[].session_id'),
    message_id: expectString(row.message_id, 'parts[].message_id'),
    sort_key: expectNumber(row.sort_key, 'parts[].sort_key'),
    part_json: expectString(row.part_json, 'parts[].part_json'),
  };
}

function parseResumeRow(value: unknown): { session_id: string; note: string; updated_at: number } {
  const row = expectRecord(value, 'resumes[]');
  return {
    session_id: expectString(row.session_id, 'resumes[].session_id'),
    note: expectString(row.note, 'resumes[].note'),
    updated_at: expectNumber(row.updated_at, 'resumes[].updated_at'),
  };
}

function parseArtifactRow(value: unknown): ArtifactRow {
  const row = expectRecord(value, 'artifacts[]');
  return {
    artifact_id: expectString(row.artifact_id, 'artifacts[].artifact_id'),
    session_id: expectString(row.session_id, 'artifacts[].session_id'),
    message_id: expectString(row.message_id, 'artifacts[].message_id'),
    part_id: expectString(row.part_id, 'artifacts[].part_id'),
    artifact_kind: expectString(row.artifact_kind, 'artifacts[].artifact_kind'),
    field_name: expectString(row.field_name, 'artifacts[].field_name'),
    preview_text: expectString(row.preview_text, 'artifacts[].preview_text'),
    content_text: expectString(row.content_text, 'artifacts[].content_text'),
    content_hash: expectNullableString(row.content_hash, 'artifacts[].content_hash'),
    metadata_json: expectString(row.metadata_json, 'artifacts[].metadata_json'),
    char_count: expectNumber(row.char_count, 'artifacts[].char_count'),
    created_at: expectNumber(row.created_at, 'artifacts[].created_at'),
  };
}

function parseArtifactBlobRow(value: unknown): ArtifactBlobRow {
  const row = expectRecord(value, 'artifact_blobs[]');
  return {
    content_hash: expectString(row.content_hash, 'artifact_blobs[].content_hash'),
    content_text: expectString(row.content_text, 'artifact_blobs[].content_text'),
    char_count: expectNumber(row.char_count, 'artifact_blobs[].char_count'),
    created_at: expectNumber(row.created_at, 'artifact_blobs[].created_at'),
  };
}

function parseSummaryNodeRow(value: unknown): SummaryNodeRow {
  const row = expectRecord(value, 'summary_nodes[]');
  return {
    node_id: expectString(row.node_id, 'summary_nodes[].node_id'),
    session_id: expectString(row.session_id, 'summary_nodes[].session_id'),
    level: expectNumber(row.level, 'summary_nodes[].level'),
    node_kind: expectString(row.node_kind, 'summary_nodes[].node_kind'),
    start_index: expectNumber(row.start_index, 'summary_nodes[].start_index'),
    end_index: expectNumber(row.end_index, 'summary_nodes[].end_index'),
    message_ids_json: expectString(row.message_ids_json, 'summary_nodes[].message_ids_json'),
    summary_text: expectString(row.summary_text, 'summary_nodes[].summary_text'),
    created_at: expectNumber(row.created_at, 'summary_nodes[].created_at'),
  };
}

function parseSummaryEdgeRow(value: unknown): SummaryEdgeRow {
  const row = expectRecord(value, 'summary_edges[]');
  return {
    session_id: expectString(row.session_id, 'summary_edges[].session_id'),
    parent_id: expectString(row.parent_id, 'summary_edges[].parent_id'),
    child_id: expectString(row.child_id, 'summary_edges[].child_id'),
    child_position: expectNumber(row.child_position, 'summary_edges[].child_position'),
  };
}

function parseSummaryStateRow(value: unknown): SummaryStateRow {
  const row = expectRecord(value, 'summary_state[]');
  return {
    session_id: expectString(row.session_id, 'summary_state[].session_id'),
    archived_count: expectNumber(row.archived_count, 'summary_state[].archived_count'),
    latest_message_created: expectNumber(
      row.latest_message_created,
      'summary_state[].latest_message_created',
    ),
    archived_signature: expectNullableString(
      row.archived_signature,
      'summary_state[].archived_signature',
    ),
    root_node_ids_json: expectString(row.root_node_ids_json, 'summary_state[].root_node_ids_json'),
    updated_at: expectNumber(row.updated_at, 'summary_state[].updated_at'),
  };
}

function expectArray<T>(value: unknown, field: string, parseItem: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`Snapshot field "${field}" must be an array.`);
  return value.map((item) => parseItem(item));
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Snapshot field "${field}" must be a string.`);
  return value;
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Snapshot field "${field}" must be a finite number.`);
  }
  return value;
}

function expectNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return expectString(value, field);
}

function expectNullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  return expectNumber(value, field);
}

function listSnapshotWorktreeKeys(
  rows: Array<{ session_directory: string | null; worktree_key: string | null }>,
): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row.worktree_key ?? normalizeWorktreeKey(row.session_directory ?? undefined))
        .filter(Boolean),
    ),
  ] as string[];
}

function resolveSnapshotWorktreeMode(mode?: string): SnapshotWorktreeMode {
  return mode === 'preserve' || mode === 'current' ? mode : 'auto';
}

function shouldRehomeImportedSessions(
  sourceWorktreeKeys: string[],
  targetWorktreeKey: string | undefined,
  worktreeMode: SnapshotWorktreeMode,
): boolean {
  if (worktreeMode === 'preserve') return false;
  if (worktreeMode === 'current') return Boolean(targetWorktreeKey);
  if (!targetWorktreeKey) return false;
  if (sourceWorktreeKeys.length === 0) return true;
  return sourceWorktreeKeys.length === 1 && sourceWorktreeKeys[0] !== targetWorktreeKey;
}

function rehomeImportedSessionRow(
  session: SessionRow,
  directory: string,
  worktreeKey?: string,
): SessionRow {
  return {
    ...session,
    session_directory: directory,
    worktree_key: worktreeKey ?? null,
  };
}

function readExistingSessionIDs(db: SqlDatabaseLike, sessionIDs: string[]): string[] {
  if (sessionIDs.length === 0) return [];

  const rows = db
    .prepare(
      `SELECT session_id FROM sessions WHERE session_id IN (${sessionIDs.map(() => '?').join(', ')}) ORDER BY session_id ASC`,
    )
    .all(...sessionIDs) as Array<{ session_id: string }>;
  return rows.map((row) => row.session_id);
}

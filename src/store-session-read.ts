import type { SqlDatabaseLike } from './store-types.js';

/**
 * Session read operations.
 * Handles reading sessions, messages, parts, artifacts from the store.
 */

export type SessionRow = {
  session_id: string;
  title: string | null;
  parent_session_id: string | null;
  root_session_id: string | null;
  lineage_depth: number | null;
  session_directory: string | null;
  worktree_key: string | null;
  pinned: number;
  pin_reason: string | null;
  deleted: number;
  updated_at: number;
  created_at: number;
  event_count: number;
};

export type MessageRow = {
  session_id: string;
  message_id: string;
  role: string;
  created_at: number;
};

export type PartRow = {
  session_id: string;
  message_id: string;
  part_id: string;
  part_type: string;
  sort_key: number;
  state_json: string;
  created_at: number;
};

export type ArtifactRow = {
  artifact_id: string;
  session_id: string;
  message_id: string;
  part_id: string;
  artifact_kind: string;
  field_name: string;
  content_hash: string | null;
  preview_text: string;
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

export type SummaryNodeRow = {
  node_id: string;
  session_id: string;
  level: number;
  slot: number;
  archived_message_ids_json: string;
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
  archived_signature: string;
  root_node_ids_json: string;
  updated_at: number;
};

export function readSessionHeader(db: SqlDatabaseLike, sessionID: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionID) as
    | SessionRow
    | undefined;
}

export function readAllSessions(db: SqlDatabaseLike): SessionRow[] {
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as SessionRow[];
}

export function readChildSessions(db: SqlDatabaseLike, parentSessionID: string): SessionRow[] {
  return db
    .prepare('SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY updated_at DESC')
    .all(parentSessionID) as SessionRow[];
}

export function readLineageChain(db: SqlDatabaseLike, sessionID: string): SessionRow[] {
  const chain: SessionRow[] = [];
  let current: SessionRow | undefined = readSessionHeader(db, sessionID);
  while (current) {
    chain.unshift(current);
    if (!current.parent_session_id) break;
    current = readSessionHeader(db, current.parent_session_id);
  }
  return chain;
}

export function readMessagesForSession(db: SqlDatabaseLike, sessionID: string): MessageRow[] {
  return db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionID) as MessageRow[];
}

export function readPartsForSession(db: SqlDatabaseLike, sessionID: string): PartRow[] {
  return db
    .prepare('SELECT * FROM parts WHERE session_id = ? ORDER BY message_id ASC, sort_key ASC')
    .all(sessionID) as PartRow[];
}

export function readArtifactsForSession(db: SqlDatabaseLike, sessionID: string): ArtifactRow[] {
  return db
    .prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionID) as ArtifactRow[];
}

export function readArtifact(db: SqlDatabaseLike, artifactID: string): ArtifactRow | undefined {
  return db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifactID) as
    | ArtifactRow
    | undefined;
}

export function readArtifactBlob(
  db: SqlDatabaseLike,
  contentHash: string,
): ArtifactBlobRow | undefined {
  return db.prepare('SELECT * FROM artifact_blobs WHERE content_hash = ?').get(contentHash) as
    | ArtifactBlobRow
    | undefined;
}

export function readOrphanArtifactBlobRows(db: SqlDatabaseLike): ArtifactBlobRow[] {
  return db
    .prepare(
      `SELECT b.* FROM artifact_blobs b
       WHERE NOT EXISTS (
         SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash
       )
       ORDER BY b.created_at ASC`,
    )
    .all() as ArtifactBlobRow[];
}

export function readLatestSessionID(db: SqlDatabaseLike): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions ORDER BY updated_at DESC LIMIT 1')
    .get() as { session_id: string } | undefined;
  return row?.session_id;
}

export function readSessionStats(db: SqlDatabaseLike): {
  sessionCount: number;
  messageCount: number;
  artifactCount: number;
  summaryNodeCount: number;
  blobCount: number;
  orphanBlobCount: number;
  orphanBlobChars: number;
} {
  const sessions = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
  const messages = db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number };
  const artifacts = db.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as {
    count: number;
  };
  const summaryNodes = db.prepare('SELECT COUNT(*) AS count FROM summary_nodes').get() as {
    count: number;
  };
  const blobs = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(char_count), 0) AS chars
       FROM artifact_blobs b
       WHERE NOT EXISTS (
         SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash
       )`,
    )
    .get() as { count: number; chars: number };
  return {
    sessionCount: sessions.count,
    messageCount: messages.count,
    artifactCount: artifacts.count,
    summaryNodeCount: summaryNodes.count,
    blobCount: blobs.count,
    orphanBlobCount: blobs.count,
    orphanBlobChars: blobs.chars,
  };
}

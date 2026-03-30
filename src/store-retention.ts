import type { SqlDatabaseLike } from './store-types.js';

/**
 * Retention policy operations.
 * Handles stale/deleted session pruning and orphan blob cleanup.
 */

export type RetentionSessionCandidate = {
  session_id: string;
  title: string | null;
  session_directory: string | null;
  root_session_id: string | null;
  pinned: number;
  deleted: number;
  updated_at: number;
  event_count: number;
  message_count: number;
  artifact_count: number;
};

export type RetentionBlobCandidate = {
  content_hash: string;
  char_count: number;
  created_at: number;
};

export type ResolvedRetentionPolicy = {
  staleSessionDays?: number;
  deletedSessionDays?: number;
  orphanBlobDays?: number;
};

export type RetentionPruneResult = {
  deletedSessions: number;
  deletedBlobs: number;
  deletedBlobChars: number;
};

export function retentionCutoff(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

export function readSessionRetentionCandidates(
  db: SqlDatabaseLike,
  deleted: boolean,
  days: number,
  limit?: number,
): RetentionSessionCandidate[] {
  const params: Array<number | string> = [retentionCutoff(days), deleted ? 1 : 0];
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
  return db.prepare(sql).all(...params) as RetentionSessionCandidate[];
}

export function countSessionRetentionCandidates(
  db: SqlDatabaseLike,
  deleted: boolean,
  days: number,
): number {
  const row = db
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
    .get(retentionCutoff(days), deleted ? 1 : 0) as { count: number };
  return row.count;
}

export function readOrphanBlobRetentionCandidates(
  db: SqlDatabaseLike,
  days: number,
  limit?: number,
): RetentionBlobCandidate[] {
  const params: Array<number> = [retentionCutoff(days)];
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
  return db.prepare(sql).all(...params) as RetentionBlobCandidate[];
}

export function countOrphanBlobRetentionCandidates(db: SqlDatabaseLike, days: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM artifact_blobs b
       WHERE b.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash
         )`,
    )
    .get(retentionCutoff(days)) as { count: number };
  return row.count;
}

export function sumOrphanBlobRetentionChars(db: SqlDatabaseLike, days: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(char_count), 0) AS chars
       FROM artifact_blobs b
       WHERE b.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash
         )`,
    )
    .get(retentionCutoff(days)) as { chars: number };
  return row.chars;
}

export function clearSessionData(db: SqlDatabaseLike, sessionID: string): void {
  db.prepare('DELETE FROM parts WHERE session_id = ?').run(sessionID);
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionID);
  db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(sessionID);
  db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionID);
  db.prepare('DELETE FROM resumes WHERE session_id = ?').run(sessionID);
  db.prepare('DELETE FROM summary_nodes WHERE session_id = ?').run(sessionID);
  db.prepare('DELETE FROM summary_edges WHERE session_id = ?').run(sessionID);
  db.prepare('DELETE FROM summary_state WHERE session_id = ?').run(sessionID);
}

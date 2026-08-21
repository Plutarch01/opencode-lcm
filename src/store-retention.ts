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

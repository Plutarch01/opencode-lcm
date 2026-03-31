import { rankSearchCandidates, type SearchCandidate } from './search-ranking.js';
import type { SqlDatabaseLike } from './store-types.js';
import type { NormalizedSession, SearchResult } from './types.js';
import { buildSnippet, sanitizeFtsTokens, tokenizeQuery } from './utils.js';

type FtsDeps = {
  getDb(): SqlDatabaseLike;
  readScopedSessionsSync(sessionIDs?: string[]): NormalizedSession[];
  readScopedSummaryRowsSync(sessionIDs?: string[]): Array<{
    node_id: string;
    session_id: string;
    level: number;
    summary_text: string;
    created_at: number;
  }>;
  readScopedArtifactRowsSync(sessionIDs?: string[]): Array<{
    artifact_id: string;
    session_id: string;
    message_id: string;
    part_id: string;
    artifact_kind: string;
    created_at: number;
    content_text: string;
    preview_text: string;
  }>;
  ignoreToolPrefixes: string[];
  guessMessageText(
    message: NormalizedSession['messages'][number],
    ignorePrefixes: string[],
  ): string;
};

export function buildFtsQuery(query: string): string | undefined {
  const tokens = sanitizeFtsTokens(tokenizeQuery(query));
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => `${token}*`).join(' AND ');
}

export function searchWithFts(
  deps: FtsDeps,
  query: string,
  sessionIDs?: string[],
  limit = 5,
): SearchResult[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];
  if (sessionIDs && sessionIDs.length === 0) return [];

  try {
    const db = deps.getDb();
    const fetchLimit = Math.max(limit * 8, 12);
    const buildScopeClause = (ids: string[] | undefined) => {
      if (!ids) return { clause: '', params: [] as string[] };
      return {
        clause: `session_id IN (${ids.map(() => '?').join(', ')}) AND `,
        params: ids,
      };
    };
    const scope = buildScopeClause(sessionIDs);

    const messageRows = db
      .prepare(
        `SELECT message_id, session_id, role, created_at, content, snippet(message_fts, 4, '[', ']', '...', 12) AS snippet, bm25(message_fts) AS rank
         FROM message_fts
         WHERE ${scope.clause}message_fts MATCH ?
         ORDER BY rank, created_at DESC
         LIMIT ?`,
      )
      .all(...scope.params, ftsQuery, fetchLimit) as Array<{
      message_id: string;
      session_id: string;
      role: string;
      created_at: string | number;
      content: string;
      snippet: string;
      rank: number;
    }>;

    const summaryRows = db
      .prepare(
        `SELECT node_id, session_id, created_at, content, snippet(summary_fts, 4, '[', ']', '...', 14) AS snippet, bm25(summary_fts) AS rank
         FROM summary_fts
         WHERE ${scope.clause}summary_fts MATCH ?
         ORDER BY rank, created_at DESC
         LIMIT ?`,
      )
      .all(...scope.params, ftsQuery, fetchLimit) as Array<{
      node_id: string;
      session_id: string;
      created_at: string | number;
      content: string;
      snippet: string;
      rank: number;
    }>;

    const artifactRows = db
      .prepare(
        `SELECT artifact_id, session_id, artifact_kind, created_at, content, snippet(artifact_fts, 6, '[', ']', '...', 14) AS snippet, bm25(artifact_fts) AS rank
         FROM artifact_fts
         WHERE ${scope.clause}artifact_fts MATCH ?
         ORDER BY rank, created_at DESC
         LIMIT ?`,
      )
      .all(...scope.params, ftsQuery, fetchLimit) as Array<{
      artifact_id: string;
      session_id: string;
      artifact_kind: string;
      created_at: string | number;
      content: string;
      snippet: string;
      rank: number;
    }>;

    const candidates: SearchCandidate[] = [
      ...messageRows.map((row, index) => ({
        id: row.message_id,
        type: row.role,
        sessionID: row.session_id,
        timestamp: Number(row.created_at),
        snippet: row.snippet || buildSnippet(row.content, query),
        content: row.content,
        sourceKind: 'message' as const,
        sourceOrder: index,
      })),
      ...summaryRows.map((row, index) => ({
        id: row.node_id,
        type: 'summary',
        sessionID: row.session_id,
        timestamp: Number(row.created_at),
        snippet: row.snippet || buildSnippet(row.content, query),
        content: row.content,
        sourceKind: 'summary' as const,
        sourceOrder: index,
      })),
      ...artifactRows.map((row, index) => ({
        id: row.artifact_id,
        type: `artifact:${row.artifact_kind}`,
        sessionID: row.session_id,
        timestamp: Number(row.created_at),
        snippet: row.snippet || buildSnippet(row.content, query),
        content: row.content,
        sourceKind: 'artifact' as const,
        sourceOrder: index,
      })),
    ];

    return rankSearchCandidates(candidates, query, limit);
  } catch {
    return [];
  }
}

export function searchByScan(
  deps: FtsDeps,
  query: string,
  sessionIDs?: string[],
  limit = 5,
): SearchResult[] {
  const sessions = deps.readScopedSessionsSync(sessionIDs);
  const candidates: SearchCandidate[] = [];

  for (const session of sessions) {
    for (const [index, message] of session.messages.entries()) {
      const blob = deps.guessMessageText(message, deps.ignoreToolPrefixes);
      if (!blob.toLowerCase().includes(query)) continue;

      candidates.push({
        id: message.info.id,
        type: message.info.role,
        sessionID: session.sessionID,
        timestamp: message.info.time.created,
        snippet: buildSnippet(blob, query),
        content: blob,
        sourceKind: 'message',
        sourceOrder: index,
      });
    }
  }

  const summaryRows = deps.readScopedSummaryRowsSync(sessionIDs);

  summaryRows.forEach((row, index) => {
    if (!row.summary_text.toLowerCase().includes(query)) return;
    candidates.push({
      id: row.node_id,
      type: 'summary',
      sessionID: row.session_id,
      timestamp: row.created_at,
      snippet: buildSnippet(row.summary_text, query),
      content: row.summary_text,
      sourceKind: 'summary',
      sourceOrder: index,
    });
  });

  const artifactRows = deps.readScopedArtifactRowsSync(sessionIDs);

  for (const [index, row] of artifactRows.entries()) {
    const haystack = `${row.preview_text}\n${row.content_text}`.toLowerCase();
    if (!haystack.includes(query)) continue;

    candidates.push({
      id: row.artifact_id,
      type: `artifact:${row.artifact_kind}`,
      sessionID: row.session_id,
      timestamp: row.created_at,
      snippet: buildSnippet(`${row.preview_text}\n${row.content_text}`, query),
      content: row.content_text,
      sourceKind: 'artifact',
      sourceOrder: index,
    });
  }

  return rankSearchCandidates(candidates, query, limit);
}

export function replaceMessageSearchRowsSync(deps: FtsDeps, session: NormalizedSession): void {
  const db = deps.getDb();
  db.prepare('DELETE FROM message_fts WHERE session_id = ?').run(session.sessionID);
  const insert = db.prepare(
    'INSERT INTO message_fts (session_id, message_id, role, created_at, content) VALUES (?, ?, ?, ?, ?)',
  );

  for (const message of session.messages) {
    const content = deps.guessMessageText(message, deps.ignoreToolPrefixes);
    if (!content) continue;
    insert.run(
      session.sessionID,
      message.info.id,
      message.info.role,
      String(message.info.time.created),
      content,
    );
  }
}

export function replaceMessageSearchRowSync(
  deps: FtsDeps,
  sessionID: string,
  message: NormalizedSession['messages'][number],
): void {
  const db = deps.getDb();
  db.prepare('DELETE FROM message_fts WHERE message_id = ?').run(message.info.id);

  const content = deps.guessMessageText(message, deps.ignoreToolPrefixes);
  if (!content) return;

  db.prepare(
    'INSERT INTO message_fts (session_id, message_id, role, created_at, content) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionID, message.info.id, message.info.role, String(message.info.time.created), content);
}

export function rebuildSearchIndexesSync(deps: FtsDeps): void {
  const db = deps.getDb();
  db.prepare('DELETE FROM message_fts').run();
  db.prepare('DELETE FROM summary_fts').run();
  db.prepare('DELETE FROM artifact_fts').run();

  for (const session of deps.readScopedSessionsSync()) {
    replaceMessageSearchRowsSync(deps, session);
  }

  const summaryRows = db
    .prepare('SELECT * FROM summary_nodes ORDER BY created_at ASC')
    .all() as Array<{
    session_id: string;
    node_id: string;
    level: number;
    created_at: number;
    summary_text: string;
  }>;
  const insert = db.prepare(
    'INSERT INTO summary_fts (session_id, node_id, level, created_at, content) VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of summaryRows) {
    insert.run(
      row.session_id,
      row.node_id,
      String(row.level),
      String(row.created_at),
      row.summary_text,
    );
  }

  const artifactRows = db
    .prepare('SELECT * FROM artifacts ORDER BY created_at ASC')
    .all() as Array<{
    session_id: string;
    artifact_id: string;
    message_id: string;
    part_id: string;
    artifact_kind: string;
    created_at: number;
  }>;
  const insertArtifact = db.prepare(
    'INSERT INTO artifact_fts (session_id, artifact_id, message_id, part_id, artifact_kind, created_at, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of artifactRows) {
    const artifactContent = [row.artifact_id, row.artifact_kind].join(' ');
    insertArtifact.run(
      row.session_id,
      row.artifact_id,
      row.message_id,
      row.part_id,
      row.artifact_kind,
      String(row.created_at),
      artifactContent,
    );
  }
}

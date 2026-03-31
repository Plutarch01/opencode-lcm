import { getLogger } from './logging.js';
import { rankSearchCandidates, type SearchCandidate } from './search-ranking.js';
import type { ArtifactRow, SummaryNodeRow } from './store-snapshot.js';
import type { SqlDatabaseLike } from './store-types.js';
import type { NormalizedSession, SearchResult } from './types.js';
import { buildSnippet, sanitizeFtsTokens, tokenizeQuery } from './utils.js';

type FtsDeps = {
  getDb(): SqlDatabaseLike;
  readScopedSessionsSync(sessionIDs?: string[]): NormalizedSession[];
  readScopedSummaryRowsSync(sessionIDs?: string[]): SummaryNodeRow[];
  readScopedArtifactRowsSync(sessionIDs?: string[]): ArtifactRow[];
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

/**
 * Compute TF-IDF weights for candidate query tokens against the FTS5 corpus.
 * Returns tokens sorted by descending IDF score (most informative first).
 * Tokens that appear in >80% of documents are dropped as corpus-common noise.
 *
 * Uses a single FTS5 query per token to get document frequency, which is
 * acceptable since automatic retrieval works with ≤10 candidate tokens.
 */
export function computeTfidfWeights(
  db: SqlDatabaseLike,
  candidateTokens: string[],
): Array<{ token: string; idf: number }> {
  if (candidateTokens.length === 0) return [];

  // Get total document counts from each FTS table
  const messageCount = (db.prepare('SELECT COUNT(*) AS count FROM message_fts').get() as {
    count: number;
  }) ?? { count: 0 };
  const summaryCount = (db.prepare('SELECT COUNT(*) AS count FROM summary_fts').get() as {
    count: number;
  }) ?? { count: 0 };
  const artifactCount = (db.prepare('SELECT COUNT(*) AS count FROM artifact_fts').get() as {
    count: number;
  }) ?? { count: 0 };
  const totalDocs = Math.max(1, messageCount.count + summaryCount.count + artifactCount.count);

  const results: Array<{ token: string; idf: number }> = [];

  for (const token of candidateTokens) {
    // Query document frequency across all FTS tables
    // FTS5 MATCH 'token*' finds all documents containing terms with this prefix
    const query = `${token}*`;
    let docFreq = 0;

    try {
      const msgFreq = db
        .prepare('SELECT COUNT(*) AS count FROM message_fts WHERE message_fts MATCH ?')
        .get(query) as { count: number } | undefined;
      docFreq += msgFreq?.count ?? 0;
    } catch (error) {
      getLogger().debug('TF-IDF message_fts query failed for token', { token, error });
    }

    try {
      const sumFreq = db
        .prepare('SELECT COUNT(*) AS count FROM summary_fts WHERE summary_fts MATCH ?')
        .get(query) as { count: number } | undefined;
      docFreq += sumFreq?.count ?? 0;
    } catch (error) {
      getLogger().debug('TF-IDF summary_fts query failed for token', { token, error });
    }

    try {
      const artFreq = db
        .prepare('SELECT COUNT(*) AS count FROM artifact_fts WHERE artifact_fts MATCH ?')
        .get(query) as { count: number } | undefined;
      docFreq += artFreq?.count ?? 0;
    } catch (error) {
      getLogger().debug('TF-IDF artifact_fts query failed for token', { token, error });
    }

    // Smoothed IDF: log(N / (df + 1)) + 1
    // Smoothing prevents division by zero and ensures non-zero weights
    const idf = Math.log(totalDocs / (docFreq + 1)) + 1;
    results.push({ token, idf });
  }

  // Sort by descending IDF — most informative tokens first
  results.sort((a, b) => b.idf - a.idf);

  return results;
}

/**
 * Filter candidate tokens using TF-IDF weights.
 * Drops tokens whose IDF is below the median (corpus-common terms)
 * and tokens that appear in >80% of documents.
 * Returns tokens sorted by descending IDF.
 */
export function filterTokensByTfidf(
  db: SqlDatabaseLike,
  candidateTokens: string[],
  options?: { maxCommonRatio?: number; minTokens?: number },
): string[] {
  const { maxCommonRatio = 0.8, minTokens = 1 } = options ?? {};

  const weights = computeTfidfWeights(db, candidateTokens);
  if (weights.length === 0) return candidateTokens;

  // Get total docs for common-ratio threshold
  const messageCount = (db.prepare('SELECT COUNT(*) AS count FROM message_fts').get() as {
    count: number;
  }) ?? { count: 0 };
  const summaryCount = (db.prepare('SELECT COUNT(*) AS count FROM summary_fts').get() as {
    count: number;
  }) ?? { count: 0 };
  const artifactCount = (db.prepare('SELECT COUNT(*) AS count FROM artifact_fts').get() as {
    count: number;
  }) ?? { count: 0 };
  const totalDocs = Math.max(1, messageCount.count + summaryCount.count + artifactCount.count);

  // Compute median IDF
  const sortedIdfs = weights.map((w) => w.idf).sort((a, b) => a - b);
  const medianIdf =
    sortedIdfs.length % 2 === 0
      ? (sortedIdfs[sortedIdfs.length / 2 - 1] + sortedIdfs[sortedIdfs.length / 2]) / 2
      : sortedIdfs[Math.floor(sortedIdfs.length / 2)];

  // Filter: keep tokens with IDF >= median AND below common-ratio threshold
  // Always keep at least minTokens tokens (the highest-IDF ones)
  const filtered = weights.filter((w) => {
    const docRatio = 1 - Math.exp(w.idf - 1) / totalDocs;
    return w.idf >= medianIdf && docRatio <= maxCommonRatio;
  });

  // Ensure minimum token count
  if (filtered.length < minTokens) {
    return weights.slice(0, minTokens).map((w) => w.token);
  }

  return filtered.map((w) => w.token);
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
  } catch (error) {
    getLogger().debug('FTS search failed, returning empty results', { query, error });
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
    .all() as SummaryNodeRow[];
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

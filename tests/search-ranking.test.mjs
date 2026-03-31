import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { rankSearchCandidates } from '../dist/search-ranking.js';
import {
  buildFtsQuery,
  filterTokensByTfidf,
  refreshSearchIndexesSync,
} from '../dist/store-search.js';

function normalizeRows(rows) {
  return rows.map((row) => ({ ...row }));
}

test('rankSearchCandidates gives newer exact hits a real recency boost', () => {
  const ranked = rankSearchCandidates(
    [
      {
        id: 'old',
        type: 'user',
        sessionID: 's1',
        timestamp: 10,
        snippet: 'tenant mapping sqlite lives in billing cache',
        content: 'tenant mapping sqlite lives in billing cache',
        sourceKind: 'message',
        sourceOrder: 0,
      },
      {
        id: 'new',
        type: 'user',
        sessionID: 's1',
        timestamp: 100,
        snippet: 'tenant mapping sqlite lives in billing cache',
        content: 'tenant mapping sqlite lives in billing cache',
        sourceKind: 'message',
        sourceOrder: 40,
      },
    ],
    'tenant mapping sqlite',
    5,
  );

  assert.equal(ranked[0].id, 'new');
});

test('rankSearchCandidates still prefers materially stronger lexical matches', () => {
  const ranked = rankSearchCandidates(
    [
      {
        id: 'older-strong',
        type: 'user',
        sessionID: 's1',
        timestamp: 10,
        snippet: 'tenant mapping sqlite lives in billing cache',
        content: 'tenant mapping sqlite lives in billing cache',
        sourceKind: 'message',
        sourceOrder: 0,
      },
      {
        id: 'newer-weak',
        type: 'user',
        sessionID: 's1',
        timestamp: 100,
        snippet: 'tenant mapping lives in cache',
        content: 'tenant mapping lives in cache',
        sourceKind: 'message',
        sourceOrder: 40,
      },
    ],
    'tenant mapping sqlite',
    5,
  );

  assert.equal(ranked[0].id, 'older-strong');
});

test('buildFtsQuery preserves quoted phrases as phrase clauses', () => {
  assert.equal(buildFtsQuery('"tenant mapping" sqlite'), '"tenant mapping" AND sqlite*');
});

test('filterTokensByTfidf drops corpus-common terms using actual document frequency', () => {
  const db = new DatabaseSync(':memory:');

  db.exec(
    `CREATE VIRTUAL TABLE message_fts USING fts5(session_id UNINDEXED, message_id UNINDEXED, role UNINDEXED, created_at UNINDEXED, content);
     CREATE VIRTUAL TABLE summary_fts USING fts5(session_id UNINDEXED, node_id UNINDEXED, level UNINDEXED, created_at UNINDEXED, content);
     CREATE VIRTUAL TABLE artifact_fts USING fts5(session_id UNINDEXED, artifact_id UNINDEXED, message_id UNINDEXED, part_id UNINDEXED, artifact_kind UNINDEXED, created_at UNINDEXED, content);`,
  );

  db.prepare(
    'INSERT INTO message_fts (session_id, message_id, role, created_at, content) VALUES (?, ?, ?, ?, ?)',
  ).run('s1', 'm1', 'user', '1', 'common needle');
  db.prepare(
    'INSERT INTO message_fts (session_id, message_id, role, created_at, content) VALUES (?, ?, ?, ?, ?)',
  ).run('s1', 'm2', 'user', '2', 'common unique');
  db.prepare(
    'INSERT INTO message_fts (session_id, message_id, role, created_at, content) VALUES (?, ?, ?, ?, ?)',
  ).run('s1', 'm3', 'user', '3', 'common context');

  const filtered = filterTokensByTfidf(db, ['common', 'unique'], { minTokens: 1 });

  assert.deepEqual(filtered, ['unique']);
});

test('refreshSearchIndexesSync replaces only the requested session rows', () => {
  const db = new DatabaseSync(':memory:');

  db.exec(
    `CREATE VIRTUAL TABLE message_fts USING fts5(session_id UNINDEXED, message_id UNINDEXED, role UNINDEXED, created_at UNINDEXED, content);
     CREATE VIRTUAL TABLE summary_fts USING fts5(session_id UNINDEXED, node_id UNINDEXED, level UNINDEXED, created_at UNINDEXED, content);
     CREATE VIRTUAL TABLE artifact_fts USING fts5(session_id UNINDEXED, artifact_id UNINDEXED, message_id UNINDEXED, part_id UNINDEXED, artifact_kind UNINDEXED, created_at UNINDEXED, content);`,
  );

  db.prepare(
    'INSERT INTO message_fts (session_id, message_id, role, created_at, content) VALUES (?, ?, ?, ?, ?)',
  ).run('s1', 'stale-s1', 'user', '1', 'stale s1 message');
  db.prepare(
    'INSERT INTO message_fts (session_id, message_id, role, created_at, content) VALUES (?, ?, ?, ?, ?)',
  ).run('s2', 'keep-s2', 'user', '2', 'keep s2 message');
  db.prepare(
    'INSERT INTO summary_fts (session_id, node_id, level, created_at, content) VALUES (?, ?, ?, ?, ?)',
  ).run('s1', 'stale-node', '0', '1', 'stale s1 summary');
  db.prepare(
    'INSERT INTO artifact_fts (session_id, artifact_id, message_id, part_id, artifact_kind, created_at, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('s1', 'stale-artifact', 'm1', 'p1', 'file', '1', 'stale artifact content');

  const sessionS1 = {
    sessionID: 's1',
    updatedAt: 10,
    eventCount: 1,
    messages: [
      {
        info: { id: 'fresh-m1', role: 'user', time: { created: 10 } },
        parts: [
          { id: 'p1', messageID: 'fresh-m1', sessionID: 's1', type: 'text', text: 'fresh body' },
        ],
      },
    ],
  };

  refreshSearchIndexesSync(
    {
      getDb: () => db,
      readScopedSessionsSync: (sessionIDs) => (sessionIDs?.includes('s1') ? [sessionS1] : []),
      readScopedSummaryRowsSync: (sessionIDs) =>
        sessionIDs?.includes('s1')
          ? [
              {
                node_id: 'fresh-node',
                session_id: 's1',
                level: 0,
                node_kind: 'leaf',
                start_index: 0,
                end_index: 0,
                message_ids_json: '["fresh-m1"]',
                summary_text: 'fresh summary',
                created_at: 10,
              },
            ]
          : [],
      readScopedArtifactRowsSync: (sessionIDs) =>
        sessionIDs?.includes('s1')
          ? [
              {
                artifact_id: 'fresh-artifact',
                session_id: 's1',
                message_id: 'fresh-m1',
                part_id: 'p1',
                artifact_kind: 'file',
                field_name: 'attachment',
                preview_text: 'preview',
                content_text: 'artifact payload',
                content_hash: null,
                metadata_json: '{}',
                char_count: 16,
                created_at: 10,
              },
            ]
          : [],
      buildArtifactSearchContent: (row) =>
        `${row.artifact_kind} ${row.preview_text} ${row.content_text}`,
      ignoreToolPrefixes: [],
      guessMessageText: (message) => message.parts.map((part) => part.text ?? '').join('\n'),
    },
    ['s1'],
  );

  const messageRows = normalizeRows(
    db
      .prepare(
        'SELECT session_id, message_id, content FROM message_fts ORDER BY session_id, message_id',
      )
      .all(),
  );
  const summaryRows = normalizeRows(
    db
      .prepare('SELECT session_id, node_id, content FROM summary_fts ORDER BY session_id, node_id')
      .all(),
  );
  const artifactRows = normalizeRows(
    db
      .prepare(
        'SELECT session_id, artifact_id, content FROM artifact_fts ORDER BY session_id, artifact_id',
      )
      .all(),
  );

  assert.deepEqual(messageRows, [
    { session_id: 's1', message_id: 'fresh-m1', content: 'fresh body' },
    { session_id: 's2', message_id: 'keep-s2', content: 'keep s2 message' },
  ]);
  assert.deepEqual(summaryRows, [
    { session_id: 's1', node_id: 'fresh-node', content: 'fresh summary' },
  ]);
  assert.deepEqual(artifactRows, [
    {
      session_id: 's1',
      artifact_id: 'fresh-artifact',
      content: 'file preview artifact payload',
    },
  ]);
});

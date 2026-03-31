import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { rankSearchCandidates } from '../dist/search-ranking.js';
import { buildFtsQuery, filterTokensByTfidf } from '../dist/store-search.js';

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

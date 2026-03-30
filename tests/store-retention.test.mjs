import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  clearSessionData,
  countOrphanBlobRetentionCandidates,
  countSessionRetentionCandidates,
  readOrphanBlobRetentionCandidates,
  readSessionRetentionCandidates,
  retentionCutoff,
  sumOrphanBlobRetentionChars,
} from '../dist/store-retention.js';

function initSchema(db) {
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      title TEXT,
      parent_session_id TEXT,
      root_session_id TEXT,
      lineage_depth INTEGER,
      session_directory TEXT,
      worktree_key TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      pin_reason TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL,
      created_at REAL NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at REAL NOT NULL,
      PRIMARY KEY (session_id, message_id)
    );
    CREATE TABLE parts (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      part_id TEXT NOT NULL,
      part_type TEXT NOT NULL,
      sort_key INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at REAL NOT NULL,
      PRIMARY KEY (session_id, message_id, part_id)
    );
    CREATE TABLE artifacts (
      artifact_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      part_id TEXT NOT NULL,
      artifact_kind TEXT NOT NULL,
      field_name TEXT NOT NULL,
      content_hash TEXT,
      preview_text TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      created_at REAL NOT NULL
    );
    CREATE TABLE artifact_blobs (
      content_hash TEXT PRIMARY KEY,
      content_text TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      created_at REAL NOT NULL
    );
    CREATE TABLE resumes (session_id TEXT PRIMARY KEY, resume_json TEXT NOT NULL);
    CREATE TABLE summary_nodes (
      node_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, level INTEGER NOT NULL,
      slot INTEGER NOT NULL, archived_message_ids_json TEXT NOT NULL,
      summary_text TEXT NOT NULL, created_at REAL NOT NULL
    );
    CREATE TABLE summary_edges (
      session_id TEXT NOT NULL, parent_id TEXT NOT NULL, child_id TEXT NOT NULL,
      child_position INTEGER NOT NULL, PRIMARY KEY (session_id, parent_id, child_id)
    );
    CREATE TABLE summary_state (
      session_id TEXT PRIMARY KEY, archived_count INTEGER NOT NULL,
      latest_message_created REAL NOT NULL, archived_signature TEXT NOT NULL,
      root_node_ids_json TEXT NOT NULL, updated_at REAL NOT NULL
    );
  `);
}

function insertSession(db, id, title, updatedAt, deleted = 0, pinned = 0) {
  db.prepare(
    `INSERT INTO sessions (session_id, title, parent_session_id, root_session_id, lineage_depth,
     session_directory, worktree_key, pinned, deleted, updated_at, created_at, event_count)
     VALUES (?, ?, NULL, ?, 0, '/tmp', NULL, ?, ?, ?, ?, 0)`,
  ).run(id, title, id, pinned, deleted, updatedAt, updatedAt);
}

// --- retentionCutoff ---

test('retentionCutoff computes correct timestamp', () => {
  const now = Date.now();
  const cutoff = retentionCutoff(1);
  const expected = now - 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(cutoff - expected) < 1000, 'should be within 1 second of expected');
});

// --- readSessionRetentionCandidates ---

test('readSessionRetentionCandidates returns stale sessions', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const now = Date.now();
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

  insertSession(db, 'stale', 'Stale Session', twoDaysAgo);
  insertSession(db, 'fresh', 'Fresh Session', now);

  const candidates = readSessionRetentionCandidates(db, false, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].session_id, 'stale');
  db.close();
});

test('readSessionRetentionCandidates returns deleted sessions', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const now = Date.now();
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

  insertSession(db, 'del1', 'Deleted Session', twoDaysAgo, 1);
  insertSession(db, 'active', 'Active Session', now, 0);

  const candidates = readSessionRetentionCandidates(db, true, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].session_id, 'del1');
  db.close();
});

test('readSessionRetentionCandidates excludes pinned sessions', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

  insertSession(db, 'pinned', 'Pinned Session', twoDaysAgo, 0, 1);

  const candidates = readSessionRetentionCandidates(db, false, 1);
  assert.equal(candidates.length, 0);
  db.close();
});

test('readSessionRetentionCandidates excludes sessions with children', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const now = Date.now();
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

  db.prepare(
    `INSERT INTO sessions (session_id, title, parent_session_id, root_session_id, lineage_depth,
     session_directory, worktree_key, pinned, deleted, updated_at, created_at, event_count)
     VALUES (?, ?, ?, ?, 0, '/tmp', NULL, 0, 0, ?, ?, 0)`,
  ).run('parent', 'Parent', null, 'parent', twoDaysAgo, twoDaysAgo);
  db.prepare(
    `INSERT INTO sessions (session_id, title, parent_session_id, root_session_id, lineage_depth,
     session_directory, worktree_key, pinned, deleted, updated_at, created_at, event_count)
     VALUES (?, ?, ?, ?, 1, '/tmp', NULL, 0, 0, ?, ?, 0)`,
  ).run('child', 'Child', 'parent', 'parent', now, now);

  const candidates = readSessionRetentionCandidates(db, false, 1);
  assert.equal(candidates.length, 0, 'parent should be excluded because it has a child');
  db.close();
});

test('readSessionRetentionCandidates respects limit', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < 5; i++) {
    insertSession(db, `s${i}`, `Session ${i}`, twoDaysAgo - i * 1000);
  }

  const candidates = readSessionRetentionCandidates(db, false, 1, 2);
  assert.equal(candidates.length, 2);
  db.close();
});

// --- countSessionRetentionCandidates ---

test('countSessionRetentionCandidates returns correct count', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

  insertSession(db, 's1', 'Session 1', twoDaysAgo);
  insertSession(db, 's2', 'Session 2', twoDaysAgo);
  insertSession(db, 's3', 'Session 3', Date.now());

  const count = countSessionRetentionCandidates(db, false, 1);
  assert.equal(count, 2);
  db.close();
});

// --- readOrphanBlobRetentionCandidates ---

test('readOrphanBlobRetentionCandidates returns orphan blobs', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

  db.prepare(
    'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at) VALUES (?, ?, ?, ?)',
  ).run('hash1', 'orphan content', 100, twoDaysAgo);
  db.prepare(
    'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at) VALUES (?, ?, ?, ?)',
  ).run('hash2', 'recent content', 50, Date.now());

  const blobs = readOrphanBlobRetentionCandidates(db, 1);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].content_hash, 'hash1');
  db.close();
});

test('readOrphanBlobRetentionCandidates excludes blobs referenced by artifacts', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

  db.prepare(
    'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at) VALUES (?, ?, ?, ?)',
  ).run('hash1', 'blob content', 100, twoDaysAgo);
  db.prepare(
    `INSERT INTO artifacts (artifact_id, session_id, message_id, part_id, artifact_kind,
     field_name, content_hash, preview_text, metadata_json, char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('a1', 's1', 'm1', 'p1', 'text', 'content', 'hash1', 'preview', '{}', 100, twoDaysAgo);

  const blobs = readOrphanBlobRetentionCandidates(db, 1);
  assert.equal(blobs.length, 0, 'blob should not be orphan since artifact references it');
  db.close();
});

// --- countOrphanBlobRetentionCandidates ---

test('countOrphanBlobRetentionCandidates returns correct count', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

  db.prepare(
    'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at) VALUES (?, ?, ?, ?)',
  ).run('h1', 'content1', 100, twoDaysAgo);
  db.prepare(
    'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at) VALUES (?, ?, ?, ?)',
  ).run('h2', 'content2', 200, twoDaysAgo);

  const count = countOrphanBlobRetentionCandidates(db, 1);
  assert.equal(count, 2);
  db.close();
});

// --- sumOrphanBlobRetentionChars ---

test('sumOrphanBlobRetentionChars returns total chars', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

  db.prepare(
    'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at) VALUES (?, ?, ?, ?)',
  ).run('h1', 'content1', 100, twoDaysAgo);
  db.prepare(
    'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at) VALUES (?, ?, ?, ?)',
  ).run('h2', 'content2', 250, twoDaysAgo);

  const chars = sumOrphanBlobRetentionChars(db, 1);
  assert.equal(chars, 350);
  db.close();
});

// --- clearSessionData ---

test('clearSessionData removes all session-related rows', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const now = Date.now();

  db.prepare(
    `INSERT INTO sessions (session_id, title, parent_session_id, root_session_id, lineage_depth,
     session_directory, worktree_key, pinned, deleted, updated_at, created_at, event_count)
     VALUES (?, ?, NULL, ?, 0, '/tmp', NULL, 0, 0, ?, ?, 0)`,
  ).run('s1', 'Test', 's1', now, now);
  db.prepare(
    'INSERT INTO messages (session_id, message_id, role, created_at) VALUES (?, ?, ?, ?)',
  ).run('s1', 'm1', 'user', now);
  db.prepare(
    'INSERT INTO parts (session_id, message_id, part_id, part_type, sort_key, state_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('s1', 'm1', 'p1', 'text', 0, '{"text":"hello"}', now);
  db.prepare('INSERT INTO resumes (session_id, resume_json) VALUES (?, ?)').run(
    's1',
    '{"messages":[]}',
  );

  clearSessionData(db, 's1');

  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?').get('s1').count,
    0,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('s1').count,
    0,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM parts WHERE session_id = ?').get('s1').count,
    0,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM resumes WHERE session_id = ?').get('s1').count,
    0,
  );
  db.close();
});

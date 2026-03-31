import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  readAllSessions,
  readArtifact,
  readArtifactBlob,
  readArtifactsForSession,
  readChildSessions,
  readLatestSessionID,
  readLineageChain,
  readMessagesForSession,
  readSessionHeader,
  readSessionStats,
} from '../dist/store.js';

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
    CREATE TABLE summary_nodes (
      node_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      slot INTEGER NOT NULL,
      archived_message_ids_json TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      created_at REAL NOT NULL
    );
    CREATE TABLE summary_edges (
      session_id TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      child_position INTEGER NOT NULL,
      PRIMARY KEY (session_id, parent_id, child_id)
    );
    CREATE TABLE summary_state (
      session_id TEXT PRIMARY KEY,
      archived_count INTEGER NOT NULL,
      latest_message_created REAL NOT NULL,
      archived_signature TEXT NOT NULL,
      root_node_ids_json TEXT NOT NULL,
      updated_at REAL NOT NULL
    );
  `);
}

function insertSession(db, id, title, parentID, rootID, depth, updatedAt) {
  db.prepare(
    `INSERT INTO sessions (session_id, title, parent_session_id, root_session_id, lineage_depth,
     session_directory, worktree_key, pinned, deleted, updated_at, created_at, event_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0)`,
  ).run(id, title, parentID, rootID ?? id, depth ?? 0, '/tmp', null, updatedAt, updatedAt);
}

// --- readSessionHeader ---

test('readSessionHeader returns session by ID', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  insertSession(db, 's1', 'Test Session', null, null, 0, Date.now());

  const session = readSessionHeader(db, 's1');
  assert.ok(session);
  assert.equal(session.session_id, 's1');
  assert.equal(session.title, 'Test Session');
  db.close();
});

test('readSessionHeader returns undefined for missing session', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  assert.equal(readSessionHeader(db, 'missing'), undefined);
  db.close();
});

// --- readAllSessions ---

test('readAllSessions returns all sessions ordered by updated_at desc', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const now = Date.now();
  insertSession(db, 's1', 'Old', null, null, 0, now - 1000);
  insertSession(db, 's2', 'New', null, null, 0, now);
  insertSession(db, 's3', 'Middle', null, null, 0, now - 500);

  const sessions = readAllSessions(db);
  assert.equal(sessions.length, 3);
  assert.equal(sessions[0].session_id, 's2');
  assert.equal(sessions[1].session_id, 's3');
  assert.equal(sessions[2].session_id, 's1');
  db.close();
});

test('readAllSessions returns empty array when no sessions', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  assert.deepEqual(readAllSessions(db), []);
  db.close();
});

// --- readChildSessions ---

test('readChildSessions returns children of a parent', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const now = Date.now();
  insertSession(db, 'parent', 'Parent', null, null, 0, now);
  insertSession(db, 'child1', 'Child 1', 'parent', 'parent', 1, now);
  insertSession(db, 'child2', 'Child 2', 'parent', 'parent', 1, now);
  insertSession(db, 'other', 'Other', null, null, 0, now);

  const children = readChildSessions(db, 'parent');
  assert.equal(children.length, 2);
  const ids = children.map((c) => c.session_id).sort();
  assert.deepEqual(ids, ['child1', 'child2']);
  db.close();
});

// --- readLineageChain ---

test('readLineageChain returns full ancestor chain', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const now = Date.now();
  insertSession(db, 'root', 'Root', null, null, 0, now);
  insertSession(db, 'mid', 'Middle', 'root', 'root', 1, now);
  insertSession(db, 'leaf', 'Leaf', 'mid', 'root', 2, now);

  const chain = readLineageChain(db, 'leaf');
  assert.equal(chain.length, 3);
  assert.equal(chain[0].session_id, 'root');
  assert.equal(chain[1].session_id, 'mid');
  assert.equal(chain[2].session_id, 'leaf');
  db.close();
});

test('readLineageChain returns single session when no parent', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  insertSession(db, 'solo', 'Solo', null, null, 0, Date.now());

  const chain = readLineageChain(db, 'solo');
  assert.equal(chain.length, 1);
  assert.equal(chain[0].session_id, 'solo');
  db.close();
});

// --- readMessagesForSession ---

test('readMessagesForSession returns messages ordered by created_at', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const now = Date.now();
  insertSession(db, 's1', 'Test', null, null, 0, now);
  db.prepare(
    'INSERT INTO messages (session_id, message_id, role, created_at) VALUES (?, ?, ?, ?)',
  ).run('s1', 'm2', 'assistant', now + 10);
  db.prepare(
    'INSERT INTO messages (session_id, message_id, role, created_at) VALUES (?, ?, ?, ?)',
  ).run('s1', 'm1', 'user', now);

  const messages = readMessagesForSession(db, 's1');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].message_id, 'm1');
  assert.equal(messages[1].message_id, 'm2');
  db.close();
});

// --- readArtifactsForSession ---

test('readArtifactsForSession returns empty for session without artifacts', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  insertSession(db, 's1', 'Test', null, null, 0, Date.now());

  const artifacts = readArtifactsForSession(db, 's1');
  assert.deepEqual(artifacts, []);
  db.close();
});

// --- readArtifact ---

test('readArtifact returns undefined for non-existent artifact', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  assert.equal(readArtifact(db, 'non-existent'), undefined);
  db.close();
});

// --- readArtifactBlob ---

test('readArtifactBlob returns undefined for non-existent hash', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  assert.equal(readArtifactBlob(db, 'non-existent-hash'), undefined);
  db.close();
});

// --- readLatestSessionID ---

test('readLatestSessionID returns most recently updated session', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const now = Date.now();
  insertSession(db, 'old', 'Old', null, null, 0, now - 1000);
  insertSession(db, 'new', 'New', null, null, 0, now);

  assert.equal(readLatestSessionID(db), 'new');
  db.close();
});

test('readLatestSessionID returns undefined when no sessions', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  assert.equal(readLatestSessionID(db), undefined);
  db.close();
});

// --- readSessionStats ---

test('readSessionStats returns counts', () => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const now = Date.now();
  insertSession(db, 's1', 'Test', null, null, 0, now);
  db.prepare(
    'INSERT INTO messages (session_id, message_id, role, created_at) VALUES (?, ?, ?, ?)',
  ).run('s1', 'm1', 'user', now);
  db.prepare(
    'INSERT INTO messages (session_id, message_id, role, created_at) VALUES (?, ?, ?, ?)',
  ).run('s1', 'm2', 'assistant', now + 10);

  const stats = readSessionStats(db);
  assert.equal(stats.sessionCount, 1);
  assert.equal(stats.messageCount, 2);
  assert.equal(stats.artifactCount, 0);
  assert.equal(stats.summaryNodeCount, 0);
  assert.equal(stats.orphanBlobCount, 0);
  assert.equal(stats.orphanBlobChars, 0);
  db.close();
});

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { assertSingleRow, safeQuery, safeQueryOne, withTransaction } from '../dist/sql-utils.js';

// --- assertSingleRow ---

test('assertSingleRow passes for object result', () => {
  const result = { id: 1, name: 'test' };
  assert.doesNotThrow(() => assertSingleRow(result, 'test-op'));
});

test('assertSingleRow throws for non-object', () => {
  assert.throws(() => assertSingleRow(null, 'test-op'), /expected a single row/);
  assert.throws(() => assertSingleRow(42, 'test-op'), /expected a single row/);
  assert.throws(() => assertSingleRow('str', 'test-op'), /expected a single row/);
});

// --- safeQuery ---

test('safeQuery returns array of results', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO t (name) VALUES ('a'), ('b')");
  const stmt = db.prepare('SELECT * FROM t');
  const results = safeQuery(stmt, [], 'test-query');
  assert.equal(results.length, 2);
  db.close();
});

test('safeQuery throws for non-array result', () => {
  const mockStmt = {
    all: () => 'not-an-array',
  };
  assert.throws(() => safeQuery(mockStmt, [], 'test-query'), /expected array result/);
});

// --- safeQueryOne ---

test('safeQueryOne returns single row or undefined', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO t (name) VALUES ('only')");
  const stmt = db.prepare('SELECT * FROM t WHERE name = ?');
  const row = safeQueryOne(stmt, ['only'], 'test-query');
  assert.ok(row);
  assert.equal(row.name, 'only');

  const missing = safeQueryOne(stmt, ['nonexistent'], 'test-query');
  assert.equal(missing, undefined);
  db.close();
});

test('safeQueryOne throws for non-object result', () => {
  const mockStmt = {
    get: () => 42,
  };
  assert.throws(() => safeQueryOne(mockStmt, [], 'test-query'), /expected object or undefined/);
});

// --- withTransaction ---

test('withTransaction commits on success', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');

  withTransaction(db, 'insert-test', () => {
    db.exec("INSERT INTO t (name) VALUES ('committed')");
  });

  const count = db.prepare('SELECT COUNT(*) AS count FROM t').get();
  assert.equal(count.count, 1);
  db.close();
});

test('withTransaction rolls back on failure', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO t (name) VALUES ('before')");

  assert.throws(
    () =>
      withTransaction(db, 'fail-test', () => {
        db.exec("INSERT INTO t (name) VALUES ('rolled-back')");
        throw new Error('intentional failure');
      }),
    /transaction failed/,
  );

  const rows = db.prepare('SELECT name FROM t').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'before');
  db.close();
});

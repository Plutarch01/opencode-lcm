import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  assertSupportedSchemaVersionSync,
  readSchemaVersionSync,
  writeSchemaVersionSync,
} from '../dist/store.js';

test('readSchemaVersionSync returns 0 for fresh database', () => {
  const db = new DatabaseSync(':memory:');
  assert.equal(readSchemaVersionSync(db), 0);
  db.close();
});

test('writeSchemaVersionSync sets and reads back version', () => {
  const db = new DatabaseSync(':memory:');
  writeSchemaVersionSync(db, 3);
  assert.equal(readSchemaVersionSync(db), 3);
  writeSchemaVersionSync(db, 0);
  assert.equal(readSchemaVersionSync(db), 0);
  db.close();
});

test('writeSchemaVersionSync clamps negative values', () => {
  const db = new DatabaseSync(':memory:');
  writeSchemaVersionSync(db, -5);
  assert.equal(readSchemaVersionSync(db), 0);
  db.close();
});

test('assertSupportedSchemaVersionSync passes for valid version', () => {
  const db = new DatabaseSync(':memory:');
  writeSchemaVersionSync(db, 1);
  assert.doesNotThrow(() => assertSupportedSchemaVersionSync(db, 1));
  assert.doesNotThrow(() => assertSupportedSchemaVersionSync(db, 5));
  db.close();
});

test('assertSupportedSchemaVersionSync throws for unsupported version', () => {
  const db = new DatabaseSync(':memory:');
  writeSchemaVersionSync(db, 99);
  assert.throws(() => assertSupportedSchemaVersionSync(db, 1), /Unsupported store schema version/);
  db.close();
});

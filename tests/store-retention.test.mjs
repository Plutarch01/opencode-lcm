import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SqliteLcmStore } from '../dist/store.js';
import {
  captureMessage,
  cleanupWorkspace,
  createSession,
  makeOptions,
  makeWorkspace,
  textPart,
} from './helpers.mjs';

test('retention report and prune operate on the live store', async () => {
  const workspace = makeWorkspace('lcm-retention-live');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.whenIdle();
    await createSession(store, workspace, 'stale-session', 1);
    await captureMessage(store, {
      sessionID: 'stale-session',
      messageID: 'm1',
      created: 2,
      parts: [textPart('stale-session', 'm1', 'm1-p', 'stale retention body')],
    });

    const policy = {
      staleSessionDays: 0,
      deletedSessionDays: 36_500,
      orphanBlobDays: 36_500,
    };
    const report = await store.retentionReport(policy);
    const applied = await store.retentionPrune({ ...policy, apply: true });
    const stats = await store.stats();

    assert.match(report, /stale_session_candidates=1/);
    assert.match(applied, /deleted_sessions=1/);
    assert.equal(stats.sessionCount, 0);
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('orphan blob pruning uses orphaned_at as its grace-period clock', async () => {
  const workspace = makeWorkspace('lcm-retention-orphan-grace');
  const dbPath = path.join(workspace, '.lcm', 'lcm.db');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions({ largeContentThreshold: 40 }));
    await store.init();
    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [textPart('s1', 'm1', 'm1-p', 'orphan candidate body '.repeat(10))],
    });
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 3,
        part: textPart('s1', 'm1', 'm1-p', 'short replacement'),
      },
    });

    let db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const freshOrphan = db
      .prepare('SELECT content_hash, orphaned_at FROM artifact_blobs WHERE orphaned_at IS NOT NULL')
      .get();
    db.close();
    assert.equal(typeof freshOrphan.orphaned_at, 'number');

    const freshGc = await store.gcBlobs({ apply: true });
    assert.match(freshGc, /orphan_blobs=0/);

    db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    db.prepare('UPDATE artifact_blobs SET orphaned_at = 1 WHERE content_hash = ?').run(
      freshOrphan.content_hash,
    );
    db.close();

    const expiredGc = await store.gcBlobs({ apply: true });
    assert.match(expiredGc, /deleted_blobs=1/);
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

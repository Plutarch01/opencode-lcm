import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SqliteLcmStore } from '../dist/store.js';

import {
  cleanupWorkspace,
  conversationMessage,
  createSession,
  makeOptions,
  makeWorkspace,
  textPart,
} from './helpers.mjs';

test('transformMessages below threshold does not open SQLite', async () => {
  const workspace = makeWorkspace('lcm-startup-transform');
  const dbPath = path.join(workspace, '.lcm', 'lcm.db');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ minMessagesForTransform: 5, freshTailMessages: 2 }),
    );
    await store.init();

    const changed = await store.transformMessages([
      conversationMessage({
        sessionID: 's1',
        messageID: 'm1',
        created: 1,
        parts: [textPart('s1', 'm1', 'm1-p', 'keep this intact')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm2',
        created: 2,
        parts: [textPart('s1', 'm2', 'm2-p', 'still visible')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm3',
        created: 3,
        parts: [textPart('s1', 'm3', 'm3-p', 'latest message')],
      }),
    ]);

    assert.equal(changed, false);
    assert.equal(existsSync(dbPath), false);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('capture skips ignored events without opening SQLite', async () => {
  const workspace = makeWorkspace('lcm-startup-capture-noop');
  const dbPath = path.join(workspace, '.lcm', 'lcm.db');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    await store.capture({ type: 'noop.event', properties: { sessionID: 's1' } });

    assert.equal(existsSync(dbPath), false);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('capture completes pending maintenance before the first write', async () => {
  const workspace = makeWorkspace('lcm-startup-deferred-init');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    let deferredRuns = 0;
    const originalCompleteDeferredInit = store.completeDeferredInit.bind(store);
    store.completeDeferredInit = () => {
      deferredRuns += 1;
      originalCompleteDeferredInit();
    };

    await createSession(store, workspace, 's1', 1);

    assert.equal(deferredRuns, 1);
    assert.equal(store.deferredInitCompleted, true);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('lineage derives missing root metadata before background refresh runs', async () => {
  const workspace = makeWorkspace('lcm-startup-lineage-fallback');
  const dbPath = path.join(workspace, '.lcm', 'lcm.db');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await createSession(store, workspace, 'root', 1);
    await createSession(store, workspace, 'child', 2, 'root');
    store.close();

    const db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    db.prepare(
      'UPDATE sessions SET root_session_id = NULL, lineage_depth = NULL WHERE session_id = ?',
    ).run('child');
    db.close();

    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    const report = await store.lineage('child');

    assert.match(report, /Root session: root/);
    assert.match(report, /Lineage depth: 1/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

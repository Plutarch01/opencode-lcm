import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SqliteLcmStore } from '../dist/store.js';

import {
  captureMessage,
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

test('transformMessages keeps deferred maintenance idle until the async read finishes', async () => {
  const workspace = makeWorkspace('lcm-startup-transform-idle-maintenance');
  let writerStore;
  let readerStore;

  try {
    writerStore = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }),
    );
    await writerStore.init();

    await createSession(writerStore, workspace, 's1', 1);
    await captureMessage(writerStore, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [textPart('s1', 'm1', 'm1-p', 'tenant mapping sqlite lives in the billing cache')],
    });
    await captureMessage(writerStore, {
      sessionID: 's1',
      messageID: 'm2',
      created: 3,
      role: 'assistant',
      parts: [textPart('s1', 'm2', 'm2-p', 'confirmed the tenant mapping sqlite flow')],
    });
    await captureMessage(writerStore, {
      sessionID: 's1',
      messageID: 'm3',
      created: 4,
      parts: [textPart('s1', 'm3', 'm3-p', 'other archived context')],
    });
    await captureMessage(writerStore, {
      sessionID: 's1',
      messageID: 'm4',
      created: 5,
      parts: [textPart('s1', 'm4', 'm4-p', 'tenant mapping sqlite')],
    });
    writerStore.close();
    writerStore = undefined;

    readerStore = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }),
    );
    await readerStore.init();

    let deferredRuns = 0;
    const originalCompleteDeferredInit = readerStore.completeDeferredInit.bind(readerStore);
    readerStore.completeDeferredInit = () => {
      deferredRuns += 1;
      originalCompleteDeferredInit();
    };

    const originalGrep = readerStore.grep.bind(readerStore);
    let releaseFirstGrep;
    const firstGrepBlocked = new Promise((resolve) => {
      releaseFirstGrep = resolve;
    });
    let signalFirstGrep;
    const firstGrepStarted = new Promise((resolve) => {
      signalFirstGrep = resolve;
    });
    let grepCalls = 0;
    readerStore.grep = async (...args) => {
      grepCalls += 1;
      if (grepCalls === 1) {
        signalFirstGrep();
        await firstGrepBlocked;
      }
      return originalGrep(...args);
    };

    const messages = [
      conversationMessage({
        sessionID: 's1',
        messageID: 'm1',
        created: 2,
        parts: [textPart('s1', 'm1', 'm1-p', 'tenant mapping sqlite lives in the billing cache')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm2',
        created: 3,
        role: 'assistant',
        parts: [textPart('s1', 'm2', 'm2-p', 'confirmed the tenant mapping sqlite flow')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm3',
        created: 4,
        parts: [textPart('s1', 'm3', 'm3-p', 'other archived context')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm4',
        created: 5,
        parts: [textPart('s1', 'm4', 'm4-p', 'tenant mapping sqlite')],
      }),
    ];

    const transformPromise = readerStore.transformMessages(messages);
    await firstGrepStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      deferredRuns,
      0,
      'deferred maintenance should stay idle while transformMessages is still awaiting retrieval',
    );

    releaseFirstGrep();
    await transformPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(deferredRuns, 1);
  } finally {
    writerStore?.close();
    readerStore?.close();
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

test('Bun on Windows keeps part-update capture on the lightweight message path', async () => {
  const workspace = makeWorkspace('lcm-startup-bun-win-part-capture');
  let store;
  const hadBun = 'Bun' in globalThis;
  const previousBun = globalThis.Bun;

  try {
    globalThis.Bun = {};
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 10, largeContentThreshold: 200 }),
    );
    await store.init();
    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      role: 'assistant',
      parts: [
        textPart('s1', 'm1', 'm1-p1', 'A'.repeat(320)),
        textPart('s1', 'm1', 'm1-p2', 'C'.repeat(340)),
      ],
    });

    let fullSessionReads = 0;
    const hydrateFlags = [];
    const originalReadSessionSync = store.readSessionSync.bind(store);
    const originalReadMessageSync = store.readMessageSync.bind(store);

    store.readSessionSync = function (...args) {
      fullSessionReads += 1;
      return originalReadSessionSync(...args);
    };
    store.readMessageSync = function (sessionID, messageID, options) {
      hydrateFlags.push(options?.hydrateArtifacts ?? true);
      return originalReadMessageSync(sessionID, messageID, options);
    };

    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 3,
        part: textPart('s1', 'm1', 'm1-p1', 'B'.repeat(360)),
      },
    });

    assert.equal(fullSessionReads, 0);
    assert.deepEqual(hydrateFlags, [false]);

    const message = originalReadMessageSync('s1', 'm1');
    assert.equal(message.parts.find((part) => part.id === 'm1-p1')?.text, 'B'.repeat(360));
    assert.equal(message.parts.find((part) => part.id === 'm1-p2')?.text, 'C'.repeat(340));

    const artifacts = store.readArtifactsForMessageSync('m1');
    assert.equal(artifacts.length, 2);
    assert.deepEqual(
      new Set(artifacts.map((artifact) => artifact.contentText)),
      new Set(['B'.repeat(360), 'C'.repeat(340)]),
    );
  } finally {
    if (hadBun) globalThis.Bun = previousBun;
    else delete globalThis.Bun;
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

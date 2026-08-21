import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { NodeSidecarLcmStore } from '../dist/node-sidecar-store.js';
import { SqliteLcmStore } from '../dist/store.js';

function makeWorkspace(prefix) {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-`));
}

function makeOptions(overrides = {}) {
  return {
    interop: {
      contextMode: true,
      neverOverrideCompactionPrompt: true,
      ignoreToolPrefixes: ['ctx_'],
    },
    scopeDefaults: { grep: 'session', describe: 'session' },
    scopeProfiles: [],
    retention: { staleSessionDays: undefined, deletedSessionDays: 30, orphanBlobDays: 14 },
    privacy: { excludeToolPrefixes: [], excludePathPatterns: [], redactPatterns: [] },
    compactContextLimit: 1200,
    systemHint: true,
    storeDir: '.lcm',
    freshTailMessages: 2,
    minMessagesForTransform: 4,
    summaryCharBudget: 900,
    partCharBudget: 120,
    largeContentThreshold: 80,
    artifactPreviewChars: 90,
    artifactViewChars: 1200,
    binaryPreviewProviders: ['fingerprint'],
    previewBytePeek: 8,
    ...overrides,
  };
}

function sessionInfo(directory, id, created, parentID) {
  return {
    id,
    slug: id,
    projectID: 'p1',
    directory,
    parentID,
    title: id,
    createdAt: created,
    updatedAt: created,
  };
}

function userInfo(sessionID, id, created) {
  return {
    id,
    sessionID,
    role: 'user',
    time: { created },
    parts: [{ id: `${id}-p`, type: 'text', text: 'hello' }],
  };
}

async function cleanupWorkspace(workspace) {
  let attempt = 0;
  while (attempt < 8) {
    try {
      rmSync(workspace, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
      attempt += 1;
      if (attempt >= 8) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
    }
  }
}

function openRawDb(workspace) {
  return new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'));
}

test('corrupted database is quarantined and a clean database is started', async () => {
  const workspace = makeWorkspace('lcm-corrupt-recover');
  let store;

  try {
    // Create the store directory first so we can plant a corrupt database file.
    const bootstrap = new SqliteLcmStore(workspace, makeOptions());
    await bootstrap.init();
    await bootstrap.close();

    const dbDir = path.join(workspace, '.lcm');
    writeFileSync(
      path.join(dbDir, 'lcm.db'),
      Buffer.concat([
        Buffer.from('SQLite format 3\0'),
        Buffer.from('this file is intentionally corrupt and not a valid database page'.repeat(8)),
      ]),
    );

    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.captureDeferred({
      type: 'session.created',
      properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
    });
    await store.captureDeferred({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm1', 2) },
    });

    const stats = await store.stats();
    assert.ok(stats.totalEvents >= 1, 'captured events should be present after recovery');
    assert.ok(stats.recovery, 'stats should report a recovery after corruption');
    assert.ok(stats.recovery.quarantinedFiles.length > 0, 'corrupt file should be quarantined');
    const quarantined = readdirSync(dbDir).filter((f) => f.startsWith('lcm.db.corrupted-'));
    assert.equal(quarantined.length, 1, 'exactly one corrupted file should remain');
    assert.ok(existsSync(path.join(dbDir, 'lcm.db')), 'a fresh database should exist');

    await store.close();
    const reopened = new SqliteLcmStore(workspace, makeOptions());
    store = reopened;
    await reopened.init();
    const reopenedStats = await reopened.stats();
    assert.ok(reopenedStats.recovery, 'recovery status should survive process restart');
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});
test('live capture corruption is quarantined and retried once', async () => {
  const workspace = makeWorkspace('lcm-live-corrupt-recover');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.stats();

    const original = store.upsertSessionRowSync.bind(store);
    let injected = false;
    store.upsertSessionRowSync = (...args) => {
      if (!injected) {
        injected = true;
        throw Object.assign(new Error('database disk image is malformed'), {
          code: 'SQLITE_CORRUPT',
        });
      }
      return original(...args);
    };

    await store.captureDeferred({
      type: 'session.created',
      properties: { sessionID: 's-live-1', info: sessionInfo(workspace, 's-live-1', 1) },
    });

    const dbDir = path.join(workspace, '.lcm');
    const quarantined = readdirSync(dbDir).filter((name) => name.startsWith('lcm.db.corrupted-'));
    assert.equal(quarantined.length, 1, 'exactly one quarantine directory should exist');

    const stats = await store.stats();
    assert.ok(stats.recovery, 'stats should report a recovery after live corruption');
    assert.ok(stats.recovery.quarantinedFiles.length > 0, 'recovery should name quarantined files');
    assert.ok(
      stats.recovery.quarantinedFiles.some((file) => file.includes('lcm.db.corrupted-')),
      'quarantined files should include the corruption directory',
    );

    const db = openRawDb(workspace);
    const sessionRow = db
      .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
      .get('s-live-1');
    const eventRow = db
      .prepare("SELECT COUNT(*) AS count FROM events WHERE session_id = 's-live-1'")
      .get();
    db.close();
    assert.ok(sessionRow, 'triggering session should be persisted on the replacement DB');
    assert.equal(eventRow.count, 1, 'triggering event should be persisted on the replacement DB');

    await store.captureDeferred({
      type: 'session.created',
      properties: { sessionID: 's-live-2', info: sessionInfo(workspace, 's-live-2', 2) },
    });

    const db2 = openRawDb(workspace);
    const secondRow = db2
      .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
      .get('s-live-2');
    db2.close();
    assert.ok(secondRow, 'second session should be persisted after recovery');

    store.upsertSessionRowSync = () => {
      throw Object.assign(new Error('database disk image is malformed again'), {
        code: 'SQLITE_CORRUPT',
      });
    };
    await assert.rejects(
      store.capture({
        type: 'session.created',
        properties: { sessionID: 's-live-3', info: sessionInfo(workspace, 's-live-3', 3) },
      }),
      /database disk image is malformed again/,
    );
    const quarantinedAfterSecondFailure = readdirSync(dbDir).filter((name) =>
      name.startsWith('lcm.db.corrupted-'),
    );
    assert.equal(
      quarantinedAfterSecondFailure.length,
      1,
      'a store lifetime should quarantine at most once',
    );
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('compact reports storage metrics and reclaims space on apply', async () => {
  const workspace = makeWorkspace('lcm-compact');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.captureDeferred({
      type: 'session.created',
      properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
    });
    const db = openRawDb(workspace);
    const insert = db.prepare(
      'INSERT INTO events (id, session_id, event_type, ts, payload_json) VALUES (?, ?, ?, ?, ?)',
    );
    const largePayload = JSON.stringify({ data: 'x'.repeat(4096) });
    for (let i = 0; i < 1000; i += 1) {
      insert.run(`prunable-${i}`, 's1', 'test.prunable.large', 2 + i, largePayload);
    }
    db.close();

    const dbPath = path.join(workspace, '.lcm', 'lcm.db');
    const walPath = `${dbPath}-wal`;
    const physicalBytesBefore =
      statSync(dbPath).size + (existsSync(walPath) ? statSync(walPath).size : 0);

    const dryRun = await store.compact({ apply: false });
    assert.match(dryRun, /page_size=/);
    assert.match(dryRun, /free_ratio=/);
    assert.match(dryRun, /candidate_events=/);

    const applied = await store.compact({ apply: true, vacuum: true });
    assert.match(applied, /apply=true/);
    assert.match(applied, /vacuum_applied=true/);
    assert.match(applied, /vacuum_reason=requested/);
    const physicalBytesAfter =
      statSync(dbPath).size + (existsSync(walPath) ? statSync(walPath).size : 0);
    assert.ok(
      physicalBytesAfter < physicalBytesBefore,
      `compaction should shrink physical storage (${physicalBytesBefore} -> ${physicalBytesAfter})`,
    );
    const stats = await store.stats();
    assert.ok(stats.totalEvents >= 1, 'captured events should be present');

    const skipVacuum = await store.compact({ apply: true, vacuum: false });
    assert.match(skipVacuum, /vacuum_reason=disabled/);
    assert.match(skipVacuum, /vacuum_applied=false/);

    const automatic = await store.compact({ apply: true });
    assert.match(automatic, /vacuum_mode=auto/);
    assert.match(automatic, /vacuum_reason=below-threshold/);
    assert.match(automatic, /vacuum_applied=false/);
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('compact deletes prunable event types on apply', async () => {
  const workspace = makeWorkspace('lcm-compact-prune');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.captureDeferred({
      type: 'session.created',
      properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
    });
    const db = openRawDb(workspace);
    db.exec(
      "INSERT INTO events (id, session_id, event_type, ts, payload_json) VALUES ('p1', 's1', 'test.prunable.event', 5, '{}')",
    );
    db.exec(
      "INSERT INTO events (id, session_id, event_type, ts, payload_json) VALUES ('p2', 's1', 'test.prunable.event', 6, '{}')",
    );
    db.close();

    const applied = await store.compact({ apply: true });
    assert.match(applied, /deleted_events=2/);
    const stats = await store.stats();
    assert.equal(stats.totalEvents, 1);
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('doctor reports integrity, foreign keys, and malformed rows', async () => {
  const workspace = makeWorkspace('lcm-doctor-integrity');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.captureDeferred({
      type: 'session.created',
      properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
    });

    const healthy = await store.doctor({});
    assert.match(healthy, /integrity_check=ok/);
    assert.match(healthy, /foreign_key_violations=0/);
    assert.match(healthy, /malformed_event_rows=0/);

    const db = openRawDb(workspace);
    db.exec(
      "INSERT INTO events (id, session_id, event_type, ts, payload_json) VALUES ('bad', 's1', 'message.updated', 9, 'this is not json')",
    );
    db.exec(
      "INSERT INTO events (id, session_id, event_type, ts, payload_json) VALUES ('bad-bracket', 's1', 'message.updated', 10, '[garbage]')",
    );
    db.exec(
      "INSERT INTO events (id, session_id, event_type, ts, payload_json) VALUES ('permission-stub', 's1', 'permission.asked', 10, '')",
    );
    db.exec(
      "INSERT INTO events (id, session_id, event_type, ts, payload_json) VALUES ('bad-empty-message', 's1', 'message.updated', 10, '')",
    );
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(
      "INSERT INTO messages (message_id, session_id, created_at, info_json) VALUES ('orphan-message', 'missing-session', 11, '{}')",
    );
    db.close();

    const broken = await store.doctor({});
    assert.match(broken, /malformed_event_rows=3/);
    assert.match(broken, /foreign_key_violations=1/);
    assert.match(broken, /status=issues-found/);
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('orphan artifact blobs respect the configured grace period', async () => {
  const workspace = makeWorkspace('lcm-orphan-grace');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions({ retention: { orphanBlobDays: 14 } }));
    await store.init();
    await store.stats();
    await store.close();

    const db = openRawDb(workspace);
    const now = Date.now();
    db.exec(
      `INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at) VALUES ('recent', 'x', 1, ${now})`,
    );
    db.exec(
      `INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at) VALUES ('old-content-new-orphan', 'y', 1, ${now - 30 * 86400000})`,
    );
    db.exec(
      `INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at, orphaned_at) VALUES ('old-orphan', 'z', 1, ${now - 30 * 86400000}, ${now - 30 * 86400000})`,
    );
    db.close();

    const store2 = new SqliteLcmStore(
      workspace,
      makeOptions({ retention: { orphanBlobDays: 14 } }),
    );
    store = store2;
    await store2.init();
    await store2.stats();
    await store2.close();

    const verify = openRawDb(workspace);
    const rows = verify
      .prepare('SELECT content_hash FROM artifact_blobs')
      .all()
      .map((row) => row.content_hash);
    verify.close();

    assert.ok(rows.includes('recent'), 'recent orphan blob should survive the grace period');
    assert.ok(
      rows.includes('old-content-new-orphan'),
      'an old blob should receive a full grace period when it first becomes orphaned',
    );
    assert.ok(
      !rows.includes('old-orphan'),
      'a blob orphaned before the grace cutoff should be pruned',
    );
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('sidecar close rejects pending requests', async () => {
  const workspace = makeWorkspace('lcm-sidecar-close');
  const store = new NodeSidecarLcmStore(workspace, makeOptions());

  try {
    const pending = new Promise((resolve, reject) => {
      store.pending.set(999, { resolve, reject });
    });
    const rejected = assert.rejects(pending, /sidecar closed/);
    await store.close();
    await rejected;
  } finally {
    await cleanupWorkspace(workspace);
  }
});

test('capture commits its event and session state atomically', async () => {
  const workspace = makeWorkspace('lcm-capture-atomic');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.stats();

    store.upsertSessionRowSync = () => {
      throw new Error('injected persistence failure');
    };
    await assert.rejects(
      store.capture({
        type: 'session.created',
        properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
      }),
      /injected persistence failure/,
    );

    const db = openRawDb(workspace);
    const eventCount = db.prepare('SELECT COUNT(*) AS count FROM events').get().count;
    const sessionCount = db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
    db.close();
    assert.equal(eventCount, 0);
    assert.equal(sessionCount, 0);
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('close flushes deferred part updates before closing SQLite', async () => {
  const workspace = makeWorkspace('lcm-close-flush');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.captureDeferred({
      type: 'session.created',
      properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
    });
    await store.captureDeferred({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm1', 2) },
    });
    await store.captureDeferred({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 3,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'updated before close',
        },
      },
    });

    await store.close();
    const db = openRawDb(workspace);
    const row = db.prepare("SELECT part_json FROM parts WHERE part_id = 'm1-p'").get();
    db.close();
    assert.equal(JSON.parse(row.part_json).text, 'updated before close');
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('capture serialization preserves a pin made during slow externalization', async () => {
  const workspace = makeWorkspace('lcm-pin-serialization');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.capture({
      type: 'session.created',
      properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
    });
    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm1', 2) },
    });

    let notifyEntered;
    let releaseExternalization;
    const entered = new Promise((resolve) => {
      notifyEntered = resolve;
    });
    const blocked = new Promise((resolve) => {
      releaseExternalization = resolve;
    });
    const originalExternalize = store.externalizeMessage.bind(store);
    store.externalizeMessage = async (...args) => {
      notifyEntered();
      await blocked;
      return originalExternalize(...args);
    };

    const capture = store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 3,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'serialized update',
        },
      },
    });
    await entered;
    const pin = store.pinSession({ sessionID: 's1', reason: 'keep' });
    releaseExternalization();
    await Promise.all([capture, pin]);

    const db = openRawDb(workspace);
    const row = db.prepare("SELECT pinned, pin_reason FROM sessions WHERE session_id = 's1'").get();
    db.close();
    assert.equal(row.pinned, 1);
    assert.equal(row.pin_reason, 'keep');
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('close waits for an in-flight stats read', async () => {
  const workspace = makeWorkspace('lcm-close-stats');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.capture({
      type: 'session.created',
      properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
    });

    let notifyEntered;
    let releaseRead;
    const entered = new Promise((resolve) => {
      notifyEntered = resolve;
    });
    const blocked = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const originalReadSizes = store.readStoreFileSizes.bind(store);
    store.readStoreFileSizes = async () => {
      notifyEntered();
      await blocked;
      return originalReadSizes();
    };

    const stats = store.stats();
    await entered;
    let closeFinished = false;
    const close = store.close().then(() => {
      closeFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closeFinished, false);
    releaseRead();
    await Promise.all([stats, close]);
    assert.equal(closeFinished, true);
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('snapshot round-trip preserves orphan grace timestamps', async () => {
  const sourceWorkspace = makeWorkspace('lcm-snapshot-orphan-source');
  const targetWorkspace = makeWorkspace('lcm-snapshot-orphan-target');
  let sourceStore;
  let targetStore;

  try {
    sourceStore = new SqliteLcmStore(sourceWorkspace, makeOptions());
    await sourceStore.init();
    await sourceStore.stats();
    const sourceDb = openRawDb(sourceWorkspace);
    sourceDb.exec(
      "INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at, orphaned_at) VALUES ('snapshot-orphan', 'payload', 7, 10, 20)",
    );
    sourceDb.close();

    const snapshotPath = path.join(sourceWorkspace, 'snapshot.json');
    await sourceStore.exportSnapshot({ filePath: snapshotPath, scope: 'all' });
    await sourceStore.close();

    targetStore = new SqliteLcmStore(targetWorkspace, makeOptions());
    await targetStore.init();
    await targetStore.stats();
    await targetStore.importSnapshot({
      filePath: snapshotPath,
      mode: 'merge',
      worktreeMode: 'preserve',
    });

    const targetDb = openRawDb(targetWorkspace);
    const row = targetDb
      .prepare("SELECT orphaned_at FROM artifact_blobs WHERE content_hash = 'snapshot-orphan'")
      .get();
    targetDb.close();
    assert.equal(row.orphaned_at, 20);
  } finally {
    await sourceStore?.close();
    await targetStore?.close();
    await cleanupWorkspace(sourceWorkspace);
    await cleanupWorkspace(targetWorkspace);
  }
});

test('failed deferred flush requeues the failed event and the remaining batch', async () => {
  const workspace = makeWorkspace('lcm-deferred-retry');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.capture({
      type: 'session.created',
      properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
    });
    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm1', 2) },
    });

    for (const [id, text] of [
      ['p1', 'first pending update'],
      ['p2', 'second pending update'],
    ]) {
      await store.captureDeferred({
        type: 'message.part.updated',
        properties: {
          sessionID: 's1',
          time: 3,
          part: { id, sessionID: 's1', messageID: 'm1', type: 'text', text },
        },
      });
    }

    const originalCapture = store.capture.bind(store);
    let failOnce = true;
    store.capture = async (event) => {
      if (failOnce && event.type === 'message.part.updated') {
        failOnce = false;
        throw new Error('injected flush failure');
      }
      return originalCapture(event);
    };
    await assert.rejects(store.flushDeferredPartUpdates(), /injected flush failure/);
    assert.equal(store.pendingPartUpdates.size, 2);

    store.capture = originalCapture;
    await store.flushDeferredPartUpdates();
    const db = openRawDb(workspace);
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM parts WHERE message_id = 'm1'")
      .get().count;
    db.close();
    assert.equal(count, 2);
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('sidecar timeout terminates the stuck worker and permits restart', async () => {
  const workspace = makeWorkspace('lcm-sidecar-timeout');
  const store = new NodeSidecarLcmStore(workspace, makeOptions());

  try {
    await store.init();
    const stuckChild = store.child;
    assert.ok(stuckChild);
    stuckChild.stdout.pause();

    await assert.rejects(store.request('stats', undefined, 10), /timed out after 10ms/);
    assert.equal(store.child, undefined, 'timed-out worker should be detached');

    await store.init();
    assert.notEqual(store.child, stuckChild, 'the next request should start a fresh worker');
  } finally {
    await store.close();
    await cleanupWorkspace(workspace);
  }
});

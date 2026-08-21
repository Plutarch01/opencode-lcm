import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  resolveCaptureHydrationMode,
  resolveSqliteRuntime,
  resolveSqliteRuntimeCandidates,
  SqliteLcmStore,
} from '../dist/store.js';

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

function fallbackStoreDir(workspace, homeDir) {
  const worktreeKey = workspace.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const suffix = createHash('sha256').update(worktreeKey).digest('hex').slice(0, 16);
  return path.join(homeDir, '.opencode-lcm', 'stores', suffix);
}

async function cleanupWorkspace(workspace) {
  let attempt = 0;
  while (attempt < 8) {
    try {
      rmSync(workspace, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
      attempt++;
      if (attempt >= 8) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
    }
  }
}

function seedLegacyDb(workspace, { userVersion, withStrategyColumn }) {
  const dbDir = path.join(workspace, '.lcm');
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, 'lcm.db'), {
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, title TEXT, session_directory TEXT, worktree_key TEXT,
      parent_session_id TEXT, root_session_id TEXT, lineage_depth INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0, pin_reason TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0, compacted_at INTEGER,
      deleted INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      info_json TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE TABLE parts (
      part_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
      sort_key INTEGER NOT NULL DEFAULT 0, part_json TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
    );
    CREATE TABLE summary_nodes (
      node_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, level INTEGER NOT NULL,
      node_kind TEXT NOT NULL, start_index INTEGER NOT NULL, end_index INTEGER NOT NULL,
      message_ids_json TEXT NOT NULL, summary_text TEXT NOT NULL, created_at INTEGER NOT NULL
      ${withStrategyColumn ? ", strategy TEXT NOT NULL DEFAULT 'deterministic-v1'" : ''},
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE TABLE summary_state (
      session_id TEXT PRIMARY KEY, archived_count INTEGER NOT NULL,
      latest_message_created INTEGER NOT NULL, archived_signature TEXT NOT NULL DEFAULT '',
      root_node_ids_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
  `);
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (session_id, title, updated_at, event_count) VALUES (?, ?, ?, ?)',
  ).run('s1', 'Legacy session', now, 2);
  const info = (id, role) => JSON.stringify({ id, role, sessionID: 's1', time: { created: now } });
  const partJson = (id, mid, text) =>
    JSON.stringify({ id, type: 'text', text, messageID: mid, sessionID: 's1' });
  db.prepare(
    'INSERT INTO messages (message_id, session_id, created_at, info_json) VALUES (?, ?, ?, ?)',
  ).run('m1', 's1', now, info('m1', 'user'));
  db.prepare(
    'INSERT INTO messages (message_id, session_id, created_at, info_json) VALUES (?, ?, ?, ?)',
  ).run('m2', 's1', now + 1, info('m2', 'assistant'));
  db.prepare(
    'INSERT INTO parts (part_id, session_id, message_id, sort_key, part_json) VALUES (?, ?, ?, ?, ?)',
  ).run('p1', 's1', 'm1', 0, partJson('p1', 'm1', 'legacy user message alpha'));
  db.prepare(
    'INSERT INTO parts (part_id, session_id, message_id, sort_key, part_json) VALUES (?, ?, ?, ?, ?)',
  ).run('p2', 's1', 'm2', 0, partJson('p2', 'm2', 'legacy assistant reply beta'));
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
}

function sessionInfo(directory, id, created, parentID) {
  return {
    id,
    slug: id,
    projectID: 'p1',
    directory,
    parentID,
    title: id,
    version: '1',
    time: { created, updated: created },
  };
}

function userInfo(sessionID, id, created) {
  return {
    id,
    sessionID,
    role: 'user',
    time: { created },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4.1' },
  };
}

test('resolveSqliteRuntime keeps bun:sqlite as a fallback for Bun on Windows', () => {
  const options = {
    envOverride: undefined,
    isBunRuntime: true,
    platform: 'win32',
  };

  assert.equal(resolveSqliteRuntime(options), 'node');
  assert.deepEqual(resolveSqliteRuntimeCandidates(options), ['node', 'bun']);
});

test('resolveSqliteRuntime keeps bun:sqlite first for Bun on non-Windows', () => {
  const options = {
    envOverride: undefined,
    isBunRuntime: true,
    platform: 'linux',
  };

  assert.equal(resolveSqliteRuntime(options), 'bun');
  assert.deepEqual(resolveSqliteRuntimeCandidates(options), ['bun', 'node']);
});

test('resolveSqliteRuntime honors explicit override', () => {
  const options = {
    envOverride: 'bun',
    isBunRuntime: true,
    platform: 'win32',
  };

  assert.equal(resolveSqliteRuntime(options), 'bun');
  assert.deepEqual(resolveSqliteRuntimeCandidates(options), ['bun']);
});

test('resolveSqliteRuntime defaults to node outside Bun', () => {
  const options = {
    envOverride: undefined,
    isBunRuntime: false,
    platform: 'win32',
  };

  assert.equal(resolveSqliteRuntime(options), 'node');
  assert.deepEqual(resolveSqliteRuntimeCandidates(options), ['node']);
});

test('resolveCaptureHydrationMode falls back to full hydration for Bun on Windows', () => {
  const options = {
    isBunRuntime: true,
    platform: 'win32',
  };

  assert.equal(resolveCaptureHydrationMode(options), 'full');
});

test('resolveCaptureHydrationMode keeps targeted hydration outside Bun on Windows', () => {
  assert.equal(
    resolveCaptureHydrationMode({
      isBunRuntime: true,
      platform: 'linux',
    }),
    'targeted',
  );
  assert.equal(
    resolveCaptureHydrationMode({
      isBunRuntime: false,
      platform: 'win32',
    }),
    'targeted',
  );
});

test('init stamps the current schema version on disk', async () => {
  const workspace = makeWorkspace('lcm-schema-version');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    const stats = await store.stats();
    assert.equal(stats.schemaVersion, 2);

    store.close();
    store = undefined;

    const db = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const versionRow = db.prepare('PRAGMA user_version').get();
    db.close();

    assert.equal(Object.values(versionRow)[0], 2);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('init reads an initialized store even when lcm.db is readonly', async () => {
  const workspace = makeWorkspace('lcm-schema-readonly');
  const dbPath = path.join(workspace, '.lcm', 'lcm.db');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    assert.equal((await store.stats()).schemaVersion, 2);

    store.close();
    store = undefined;

    chmodSync(dbPath, 0o444);

    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    const stats = await store.stats();
    assert.equal(stats.schemaVersion, 2);
  } finally {
    store?.close();

    if (existsSync(dbPath)) {
      chmodSync(dbPath, 0o666);
    }

    await cleanupWorkspace(workspace);
  }
});

test('capture falls back to a user-writable store when the default lcm.db is readonly', async () => {
  const workspace = makeWorkspace('lcm-capture-readonly');
  const homeDir = makeWorkspace('lcm-fallback-home');
  const dbPath = path.join(workspace, '.lcm', 'lcm.db');
  const fallbackDbPath = path.join(fallbackStoreDir(workspace, homeDir), 'lcm.db');
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let store;

  try {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    store = new SqliteLcmStore(workspace, makeOptions({ storeDir: undefined }));
    await store.init();
    await store.capture({
      type: 'session.created',
      properties: { sessionID: 'primary', info: sessionInfo(workspace, 'primary', 1) },
    });

    store.close();
    store = undefined;

    chmodSync(dbPath, 0o444);

    store = new SqliteLcmStore(workspace, makeOptions({ storeDir: undefined }));
    await store.init();
    await store.capture({
      type: 'session.created',
      properties: { sessionID: 'fallback', info: sessionInfo(workspace, 'fallback', 2) },
    });

    assert.equal(existsSync(fallbackDbPath), true);

    const primaryDb = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const primarySession = primaryDb
      .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
      .get('primary');
    const missingFallbackSession = primaryDb
      .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
      .get('fallback');
    primaryDb.close();

    const fallbackDb = new DatabaseSync(fallbackDbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const fallbackSession = fallbackDb
      .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
      .get('fallback');
    fallbackDb.close();

    assert.equal(primarySession.session_id, 'primary');
    assert.equal(missingFallbackSession, undefined);
    assert.equal(fallbackSession.session_id, 'fallback');
  } finally {
    store?.close();

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }

    if (existsSync(dbPath)) {
      chmodSync(dbPath, 0o666);
    }

    await cleanupWorkspace(workspace);
    await cleanupWorkspace(homeDir);
  }
});

test('init rejects newer on-disk schema versions', async () => {
  const workspace = makeWorkspace('lcm-schema-future');
  let store;

  try {
    mkdirSync(path.join(workspace, '.lcm'), { recursive: true });
    const db = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    db.exec('PRAGMA user_version = 99');
    db.close();

    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await assert.rejects(store.stats(), /Unsupported store schema version: 99/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('opens and migrates a pre-0.15.0 (v2) store missing messages.deleted_at', async () => {
  const workspace = makeWorkspace('lcm-legacy-v2');
  let store;

  try {
    seedLegacyDb(workspace, { userVersion: 2, withStrategyColumn: true });
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    const stats = await store.stats();
    assert.equal(stats.schemaVersion, 2);

    const dbPath = path.join(workspace, '.lcm', 'lcm.db');
    const db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const columns = db
      .prepare('PRAGMA table_info(messages)')
      .all()
      .map((column) => column.name);
    const version = Object.values(db.prepare('PRAGMA user_version').get())[0];
    const deleted = db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE deleted_at IS NOT NULL')
      .get();
    const messages = db.prepare('SELECT COUNT(*) AS count FROM messages').get();
    db.close();

    assert.ok(columns.includes('deleted_at'));
    assert.equal(version, 2);
    assert.equal(deleted.count, 0);
    assert.equal(messages.count, 2);

    const description = await store.describe({ sessionID: 's1' });
    assert.match(description, /legacy user message alpha/);
    assert.ok(!description.includes('[removed]'));
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('opens and migrates a pre-0.15.0 (v1) store missing legacy columns', async () => {
  const workspace = makeWorkspace('lcm-legacy-v1');
  let store;

  try {
    seedLegacyDb(workspace, { userVersion: 1, withStrategyColumn: false });
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    const stats = await store.stats();
    assert.equal(stats.schemaVersion, 2);

    const dbPath = path.join(workspace, '.lcm', 'lcm.db');
    const db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const messageColumns = db
      .prepare('PRAGMA table_info(messages)')
      .all()
      .map((column) => column.name);
    const summaryNodeColumns = db
      .prepare('PRAGMA table_info(summary_nodes)')
      .all()
      .map((column) => column.name);
    const version = Object.values(db.prepare('PRAGMA user_version').get())[0];
    const deleted = db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE deleted_at IS NOT NULL')
      .get();
    const messages = db.prepare('SELECT COUNT(*) AS count FROM messages').get();
    db.close();

    assert.ok(messageColumns.includes('deleted_at'));
    assert.ok(summaryNodeColumns.includes('strategy'));
    assert.equal(version, 2);
    assert.equal(deleted.count, 0);
    assert.equal(messages.count, 2);

    const description = await store.describe({ sessionID: 's1' });
    assert.match(description, /legacy user message alpha/);
    assert.ok(!description.includes('[removed]'));
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('init is lazy and does not create the database until first operation', async () => {
  const workspace = makeWorkspace('lcm-lazy-init');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    const stats = await store.stats();
    assert.equal(stats.schemaVersion, 2);
    assert.equal(existsSync(path.join(workspace, '.lcm', 'lcm.db')), true);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('exports and imports a portable snapshot', async () => {
  const sourceDir = makeWorkspace('lcm-export-src');
  const targetDir = makeWorkspace('lcm-export-dst');
  const snapshotPath = path.join(sourceDir, 'snapshot.json');
  let source;
  let target;

  try {
    source = new SqliteLcmStore(sourceDir, makeOptions());
    await source.init();
    await source.capture({
      type: 'session.created',
      properties: { sessionID: 'root', info: sessionInfo(sourceDir, 'root', 1) },
    });
    await source.capture({
      type: 'message.updated',
      properties: { sessionID: 'root', info: userInfo('root', 'm1', 2) },
    });
    await source.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 'root',
        time: 2,
        part: {
          id: 'p1',
          sessionID: 'root',
          messageID: 'm1',
          type: 'text',
          text: 'portable snapshot body',
        },
      },
    });
    await source.pinSession({ sessionID: 'root', reason: 'keep for export' });

    const exportText = await source.exportSnapshot({ filePath: snapshotPath, scope: 'all' });
    assert.match(exportText, /sessions=1/);

    target = new SqliteLcmStore(targetDir, makeOptions());
    await target.init();
    const importText = await target.importSnapshot({ filePath: snapshotPath, mode: 'replace' });
    assert.match(importText, /messages=1/);

    const describe = await target.describe({ sessionID: 'root' });
    assert.match(describe, /Pinned: yes/);

    const grep = await target.grep({ query: 'portable snapshot body', sessionID: 'root' });
    assert.equal(grep[0]?.id, 'm1');
  } finally {
    source?.close();
    target?.close();
    await cleanupWorkspace(sourceDir);
    await cleanupWorkspace(targetDir);
  }
});

test('applies worktree scope defaults from profiles', async () => {
  const workspace = makeWorkspace('lcm-scope');
  let store;
  const options = makeOptions({
    scopeDefaults: { grep: 'session', describe: 'session' },
    scopeProfiles: [{ worktree: 'c:/repo/a', grep: 'worktree', describe: 'root' }],
  });

  try {
    store = new SqliteLcmStore(workspace, options);
    await store.init();

    for (const [id, dir, parentID, created] of [
      ['rootA', 'C:/repo/a', undefined, 1],
      ['branchA', 'C:/repo/a', 'rootA', 2],
      ['rootB', 'C:/repo/a', undefined, 3],
    ]) {
      await store.capture({
        type: 'session.created',
        properties: { sessionID: id, info: sessionInfo(dir, id, created, parentID) },
      });
    }

    for (const [sessionID, id, created, text] of [
      ['branchA', 'm1', 4, 'worktree default query in branchA'],
      ['rootB', 'm2', 5, 'worktree default query in rootB'],
      ['rootA', 'm3', 6, 'root describe session'],
    ]) {
      await store.capture({
        type: 'message.updated',
        properties: { sessionID, info: userInfo(sessionID, id, created) },
      });
      await store.capture({
        type: 'message.part.updated',
        properties: {
          sessionID,
          time: created,
          part: { id: `${id}-p`, sessionID, messageID: id, type: 'text', text },
        },
      });
    }

    const grep = await store.grep({ query: 'worktree default query', sessionID: 'branchA' });
    assert.deepEqual([...new Set(grep.map((item) => item.sessionID))].sort(), ['branchA', 'rootB']);

    const describe = await store.describe({ sessionID: 'branchA' });
    assert.match(describe, /Scope: root/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('message.updated preserves existing parts and search content', async () => {
  const workspace = makeWorkspace('lcm-message-update');
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
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'preserve this message body',
        },
      },
    });

    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm1', 3) },
    });

    const grep = await store.grep({
      query: 'preserve this message body',
      sessionID: 's1',
      limit: 3,
    });
    const describe = await store.describe({ sessionID: 's1' });

    assert.equal(grep[0]?.id, 'm1');
    assert.match(describe, /preserve this message body/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('message.removed tombstones reverted content without recalling it', async () => {
  const workspace = makeWorkspace('lcm-message-removed');
  const dbPath = path.join(workspace, '.lcm', 'lcm.db');
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
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'reverted memory body '.repeat(8),
        },
      },
    });

    const before = await store.grep({ query: 'reverted memory body', sessionID: 's1', limit: 3 });
    assert.ok(before.some((result) => result.id === 'm1' || result.type.startsWith('artifact:')));

    await store.capture({
      type: 'message.removed',
      properties: { sessionID: 's1', messageID: 'm1' },
    });

    const after = await store.grep({ query: 'reverted memory body', sessionID: 's1', limit: 3 });
    const describe = await store.describe({ sessionID: 's1' });
    const stats = await store.stats();
    const db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const tombstone = db.prepare('SELECT deleted_at FROM messages WHERE message_id = ?').get('m1');
    const retainedParts = db
      .prepare('SELECT COUNT(*) AS count FROM parts WHERE message_id = ?')
      .get('m1');
    db.prepare(
      `INSERT INTO summary_nodes
       (node_id, session_id, level, node_kind, start_index, end_index, message_ids_json, summary_text, strategy, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'removed-pointer',
      's1',
      0,
      'leaf',
      0,
      1,
      JSON.stringify(['m1', 'pre-migration-pruned']),
      'stale summary pointer',
      'deterministic-v2',
      Date.now(),
    );
    db.close();
    const expanded = await store.expand({ nodeID: 'removed-pointer', includeRaw: true });

    assert.equal(after.length, 0);
    assert.ok(!describe.includes('reverted memory body'));
    assert.equal(stats.artifactCount, 1);
    assert.equal(stats.orphanArtifactBlobCount, 0);
    assert.equal(typeof tombstone.deleted_at, 'number');
    assert.equal(retainedParts.count, 1);
    assert.match(expanded, /\[removed\].*m1.*reverted memory body/);
    assert.match(expanded, /\[pruned: pre-migration-pruned\]/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('message.part.updated replaces stale artifacts and retains the blob through its grace period', async () => {
  const workspace = makeWorkspace('lcm-message-part-replace');
  const dbPath = path.join(workspace, '.lcm', 'lcm.db');
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
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'large stale body '.repeat(12),
        },
      },
    });

    const before = await store.stats();
    assert.equal(before.artifactCount, 1);
    let db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const initialArtifact = db
      .prepare('SELECT artifact_id FROM artifacts WHERE message_id = ?')
      .get('m1');
    db.close();

    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 3,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'large stale body '.repeat(12),
        },
      },
    });

    db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const stableArtifacts = db
      .prepare('SELECT artifact_id FROM artifacts WHERE message_id = ?')
      .all('m1');
    db.close();
    assert.deepEqual(stableArtifacts, [initialArtifact]);

    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 4,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'short replacement',
        },
      },
    });

    const grep = await store.grep({ query: 'large stale body', sessionID: 's1', limit: 3 });
    const describe = await store.describe({ sessionID: 's1' });
    const after = await store.stats();

    assert.equal(grep.length, 0);
    assert.match(describe, /short replacement/);
    assert.equal(after.artifactCount, 0);
    assert.equal(after.orphanArtifactBlobCount, 1);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('fresh-tail message.part.updated avoids full session hydration', async () => {
  const workspace = makeWorkspace('lcm-fresh-tail-part-update');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions({ freshTailMessages: 4 }));
    await store.init();

    await store.capture({
      type: 'session.created',
      properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
    });
    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm1', 2) },
    });

    let readSessionCalls = 0;
    const originalReadSessionSync = store.readSessionSync.bind(store);
    store.readSessionSync = (...args) => {
      readSessionCalls += 1;
      return originalReadSessionSync(...args);
    };

    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'fresh tail body',
        },
      },
    });

    store.readSessionSync = originalReadSessionSync;

    assert.equal(readSessionCalls, 0);
    const describe = await store.describe({ sessionID: 's1' });
    assert.match(describe, /fresh tail body/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('fresh-tail message.updated preserves search content without full session hydration', async () => {
  const workspace = makeWorkspace('lcm-fresh-tail-message-update');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions({ freshTailMessages: 4 }));
    await store.init();

    await store.capture({
      type: 'session.created',
      properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
    });
    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm1', 2) },
    });
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'searchable fresh tail body',
        },
      },
    });

    let readSessionCalls = 0;
    const originalReadSessionSync = store.readSessionSync.bind(store);
    store.readSessionSync = (...args) => {
      readSessionCalls += 1;
      return originalReadSessionSync(...args);
    };

    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm1', 2) },
    });

    store.readSessionSync = originalReadSessionSync;

    assert.equal(readSessionCalls, 0);
    const grep = await store.grep({
      query: 'searchable fresh tail body',
      sessionID: 's1',
      limit: 3,
    });
    assert.ok(grep.some((result) => result.id === 'm1'));
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('message.part.delta is ignored by the event log without rewriting archived session state', async () => {
  const workspace = makeWorkspace('lcm-part-delta');
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
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'stable archived body',
        },
      },
    });

    const before = await store.describe({ sessionID: 's1' });
    await store.capture({
      type: 'message.part.delta',
      properties: {
        sessionID: 's1',
        messageID: 'm1',
        partID: 'm1-p',
        field: 'text',
        delta: ' stream chunk',
      },
    });
    const after = await store.describe({ sessionID: 's1' });
    const stats = await store.stats();

    assert.equal(after, before);
    assert.equal(stats.totalEvents, 3);
    assert.equal(stats.eventTypes['message.part.delta'], undefined);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('captureDeferred coalesces repeated message.part.updated events for the same part', async () => {
  const workspace = makeWorkspace('lcm-deferred-part-updates');
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
        time: 2,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'draft',
        },
      },
    });
    await store.captureDeferred({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'draft expanded',
        },
      },
    });
    await store.captureDeferred({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'final stable body',
        },
      },
    });

    const describe = await store.describe({ sessionID: 's1' });
    const stats = await store.stats();

    assert.match(describe, /final stable body/);
    assert.equal(stats.totalEvents, 3);
    assert.equal(stats.eventTypes['message.part.updated'], 1);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('compactEventLog prunes transient event rows without touching archived state', async () => {
  const workspace = makeWorkspace('lcm-compact-event-log');
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
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'm1-p',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'stable archived body',
        },
      },
    });

    const before = await store.describe({ sessionID: 's1' });
    await store.close();
    store = undefined;

    const db = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    db.prepare(
      `INSERT INTO events (id, session_id, event_type, ts, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('legacy-status-row', 's1', 'session.status', 3, '[session.status]');
    db.close();

    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    const dryRun = await store.compactEventLog({ limit: 5, vacuum: false });
    const applied = await store.compactEventLog({ apply: true, limit: 5, vacuum: false });
    const after = await store.describe({ sessionID: 's1' });
    const stats = await store.stats();

    assert.match(dryRun, /candidate_events=1/);
    assert.match(dryRun, /session\.status count=1/);
    assert.match(applied, /deleted_events=1/);
    assert.match(applied, /vacuum_applied=false/);
    assert.equal(after, before);
    assert.equal(stats.totalEvents, 3);
    assert.equal(stats.eventTypes['session.status'], undefined);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('search hardening drops FTS5 reserved words and punctuation noise', async () => {
  const workspace = makeWorkspace('lcm-fts-hardening');
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
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'sqlite migration planner runs nightly',
        },
      },
    });

    const hit = await store.grep({ query: 'sqlite migration', sessionID: 's1', limit: 3 });
    assert.equal(hit[0]?.id, 'm1');

    const reservedOnly = await store.grep({ query: 'and or not', sessionID: 's1', limit: 3 });
    assert.ok(Array.isArray(reservedOnly));

    const mixedReserved = await store.grep({
      query: 'sqlite and migration not planner',
      sessionID: 's1',
      limit: 3,
    });
    assert.equal(mixedReserved[0]?.id, 'm1');

    const punctuationHeavy = await store.grep({ query: '!!!sqlite!!!', sessionID: 's1', limit: 3 });
    assert.equal(punctuationHeavy[0]?.id, 'm1');

    const sqlReserved = await store.grep({
      query: 'select from where group by order',
      sessionID: 's1',
      limit: 3,
    });
    assert.ok(Array.isArray(sqlReserved));

    const emptyAfterStrip = await store.grep({ query: '!!! && || ??', sessionID: 's1', limit: 3 });
    assert.equal(emptyAfterStrip.length, 0);

    const nearKeyword = await store.grep({
      query: 'sqlite near migration',
      sessionID: 's1',
      limit: 3,
    });
    assert.equal(nearKeyword[0]?.id, 'm1');
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('synthetic text parts are excluded from grep results', async () => {
  const workspace = makeWorkspace('lcm-synthetic');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.capture({
      type: 'session.created',
      properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
    });

    // Message with real content
    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm1', 2) },
    });
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'real user content about migration',
        },
      },
    });

    // Message with archive-placeholder text (elided by transform)
    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm2', 3) },
    });
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 3,
        part: {
          id: 'p2',
          sessionID: 's1',
          messageID: 'm2',
          type: 'text',
          text: '[Archived by opencode-lcm: older text elided. Use lcm_resume, lcm_grep, or lcm_expand for details.]',
        },
      },
    });

    // Message with externalized placeholder text
    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm3', 4) },
    });
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 4,
        part: {
          id: 'p3',
          sessionID: 's1',
          messageID: 'm3',
          type: 'text',
          text: '[Externalized file as art_123 (400 chars). Use lcm_artifact for full content.]',
        },
      },
    });

    // Message with retrieved-context metadata marker
    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm4', 5) },
    });
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 5,
        part: {
          id: 'p4',
          sessionID: 's1',
          messageID: 'm4',
          type: 'text',
          text: 'migration helper context retrieved from archive',
          metadata: { opencodeLcm: 'retrieved-context' },
        },
      },
    });

    // Grep for "migration" — should only find m1, not synthetic m2/m3/m4
    const results = await store.grep({ query: 'migration', sessionID: 's1', limit: 10 });
    const ids = results.map((r) => r.id);
    assert.ok(ids.includes('m1'), 'real content should be found');
    assert.ok(!ids.includes('m2'), 'archive placeholder should be filtered');
    assert.ok(!ids.includes('m3'), 'externalized placeholder should be filtered');
    assert.ok(!ids.includes('m4'), 'retrieved-context marker should be filtered');
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('retention pruning skips pinned sessions and cleans orphan blobs', async () => {
  const workspace = makeWorkspace('lcm-retention');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({
        retention: { staleSessionDays: undefined, deletedSessionDays: 30, orphanBlobDays: 14 },
      }),
    );
    await store.init();

    await store.capture({
      type: 'session.created',
      properties: { sessionID: 'keep', info: sessionInfo(workspace, 'keep', 1) },
    });
    await store.capture({
      type: 'session.created',
      properties: { sessionID: 'drop', info: sessionInfo(workspace, 'drop', 2) },
    });

    for (const [sessionID, id, created, text] of [
      ['keep', 'm1', 3, 'keep pinned session'],
      ['drop', 'm2', 4, 'large blob '.repeat(20)],
    ]) {
      await store.capture({
        type: 'message.updated',
        properties: { sessionID, info: userInfo(sessionID, id, created) },
      });
      await store.capture({
        type: 'message.part.updated',
        properties: {
          sessionID,
          time: created,
          part: { id: `${id}-p`, sessionID, messageID: id, type: 'text', text },
        },
      });
    }

    await store.pinSession({ sessionID: 'keep', reason: 'do not prune' });
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 'drop',
        time: 5,
        part: {
          id: 'm2-p',
          sessionID: 'drop',
          messageID: 'm2',
          type: 'text',
          text: 'short replacement',
        },
      },
    });

    const dryRun = await store.retentionPrune({
      staleSessionDays: 0,
      orphanBlobDays: 0,
      apply: false,
    });
    assert.match(dryRun, /deleted_session_candidates=0|stale_session_candidates=1/);
    assert.ok(!dryRun.includes('keep pinned session'));

    const applied = await store.retentionPrune({
      staleSessionDays: 0,
      orphanBlobDays: 0,
      apply: true,
    });
    assert.match(applied, /deleted_sessions=1/);
    assert.match(applied, /deleted_blobs_preview:/);

    const stats = await store.stats();
    assert.equal(stats.sessionCount, 1);
    assert.equal(stats.pinnedSessionCount, 1);
    assert.equal(stats.orphanArtifactBlobCount, 0);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('deferred init runs at startup and grep works without capture', async () => {
  const workspace = makeWorkspace('lcm-deferred-init');
  let store;

  try {
    // First session: capture data then close
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
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'deferred init grep target content',
        },
      },
    });
    store.close();

    // Reopen and verify grep works BEFORE any new capture
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    const results = await store.grep({ query: 'deferred init grep target', limit: 3 });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'm1');
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('deferred init applies retention pruning at startup', async () => {
  const workspace = makeWorkspace('lcm-deferred-retention');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    await store.whenIdle();
    await store.capture({
      type: 'session.created',
      properties: { sessionID: 'drop', info: sessionInfo(workspace, 'drop', 1) },
    });
    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 'drop', info: userInfo('drop', 'm1', 2) },
    });
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 'drop',
        time: 2,
        part: {
          id: 'p1',
          sessionID: 'drop',
          messageID: 'm1',
          type: 'text',
          text: 'prune me on startup',
        },
      },
    });
    const before = await store.stats();
    assert.equal(before.sessionCount, 1);
    assert.equal(before.totalEvents, 3);

    store.close();

    store = new SqliteLcmStore(
      workspace,
      makeOptions({
        retention: {
          staleSessionDays: 0,
          deletedSessionDays: undefined,
          orphanBlobDays: undefined,
        },
      }),
    );
    await store.init();
    await store.whenIdle();

    const stats = await store.stats();
    assert.equal(stats.sessionCount, 0);
    assert.equal(stats.totalEvents, 0);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('deferred init preserves existing summary and FTS state on reopen', async () => {
  const workspace = makeWorkspace('lcm-deferred-reopen-preserve');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 3 }),
    );
    await store.init();
    await store.capture({
      type: 'session.created',
      properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
    });
    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm1', 2) },
    });
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'first archived message for reopen coverage',
        },
      },
    });
    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm2', 3) },
    });
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 3,
        part: {
          id: 'p2',
          sessionID: 's1',
          messageID: 'm2',
          type: 'text',
          text: 'second archived message for reopen coverage',
        },
      },
    });
    await store.capture({
      type: 'message.updated',
      properties: { sessionID: 's1', info: userInfo('s1', 'm3', 4) },
    });
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 4,
        part: {
          id: 'p3',
          sessionID: 's1',
          messageID: 'm3',
          type: 'text',
          text: 'fresh tail message for reopen coverage',
        },
      },
    });

    const initialResults = await store.grep({ query: 'second archived message reopen', limit: 3 });
    assert.ok(initialResults.some((result) => result.id === 'm2'));
    const initialResume = await store.resume('s1');
    assert.match(initialResume, /LCM prototype resume note/);

    store.close();

    const db = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const before = {
      messageFts: db.prepare('SELECT COUNT(*) AS count FROM message_fts').get().count,
      summaryFts: db.prepare('SELECT COUNT(*) AS count FROM summary_fts').get().count,
      artifactFts: db.prepare('SELECT COUNT(*) AS count FROM artifact_fts').get().count,
      summaryNodes: db.prepare('SELECT COUNT(*) AS count FROM summary_nodes').get().count,
      summaryState: db.prepare('SELECT COUNT(*) AS count FROM summary_state').get().count,
      resumes: db.prepare('SELECT COUNT(*) AS count FROM resumes').get().count,
    };
    db.close();

    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 3 }),
    );
    await store.init();

    const reopenedResults = await store.grep({ query: 'second archived message reopen', limit: 3 });
    assert.ok(reopenedResults.some((result) => result.id === 'm2'));
    const reopenedResume = await store.resume('s1');
    assert.match(reopenedResume, /LCM prototype resume note/);

    const reopenedDb = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const after = {
      messageFts: reopenedDb.prepare('SELECT COUNT(*) AS count FROM message_fts').get().count,
      summaryFts: reopenedDb.prepare('SELECT COUNT(*) AS count FROM summary_fts').get().count,
      artifactFts: reopenedDb.prepare('SELECT COUNT(*) AS count FROM artifact_fts').get().count,
      summaryNodes: reopenedDb.prepare('SELECT COUNT(*) AS count FROM summary_nodes').get().count,
      summaryState: reopenedDb.prepare('SELECT COUNT(*) AS count FROM summary_state').get().count,
      resumes: reopenedDb.prepare('SELECT COUNT(*) AS count FROM resumes').get().count,
    };
    reopenedDb.close();

    assert.deepEqual(after, before);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('startup orphan blob cleanup does not trigger unrelated session rebuilds', async () => {
  const workspace = makeWorkspace('lcm-startup-orphan-cleanup');
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
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: {
          id: 'p1',
          sessionID: 's1',
          messageID: 'm1',
          type: 'text',
          text: 'orphan cleanup baseline content',
        },
      },
    });
    const baseline = await store.stats();
    assert.equal(baseline.sessionCount, 1);

    store.close();

    const db = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    db.prepare(
      'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at, orphaned_at) VALUES (?, ?, ?, ?, ?)',
    ).run('orphan-test-hash', 'orphaned startup blob', 19, 1, 1);
    const before = {
      summaryNodes: db.prepare('SELECT COUNT(*) AS count FROM summary_nodes').get().count,
      summaryState: db.prepare('SELECT COUNT(*) AS count FROM summary_state').get().count,
      messageFts: db.prepare('SELECT COUNT(*) AS count FROM message_fts').get().count,
      summaryFts: db.prepare('SELECT COUNT(*) AS count FROM summary_fts').get().count,
      artifactFts: db.prepare('SELECT COUNT(*) AS count FROM artifact_fts').get().count,
      orphanBlobs: db
        .prepare(
          'SELECT COUNT(*) AS count FROM artifact_blobs b WHERE NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash)',
        )
        .get().count,
    };
    assert.equal(before.orphanBlobs, 1);
    db.close();

    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();
    const stats = await store.stats();
    assert.equal(stats.sessionCount, 1);

    const reopenedDb = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const after = {
      summaryNodes: reopenedDb.prepare('SELECT COUNT(*) AS count FROM summary_nodes').get().count,
      summaryState: reopenedDb.prepare('SELECT COUNT(*) AS count FROM summary_state').get().count,
      messageFts: reopenedDb.prepare('SELECT COUNT(*) AS count FROM message_fts').get().count,
      summaryFts: reopenedDb.prepare('SELECT COUNT(*) AS count FROM summary_fts').get().count,
      artifactFts: reopenedDb.prepare('SELECT COUNT(*) AS count FROM artifact_fts').get().count,
      orphanBlobs: reopenedDb
        .prepare(
          'SELECT COUNT(*) AS count FROM artifact_blobs b WHERE NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash)',
        )
        .get().count,
    };
    reopenedDb.close();

    assert.equal(after.orphanBlobs, 0);
    assert.equal(after.summaryNodes, before.summaryNodes);
    assert.equal(after.summaryState, before.summaryState);
    assert.equal(after.messageFts, before.messageFts);
    assert.equal(after.summaryFts, before.summaryFts);
    assert.equal(after.artifactFts, before.artifactFts);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

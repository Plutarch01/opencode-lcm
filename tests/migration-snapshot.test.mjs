import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SqliteLcmStore } from '../dist/store.js';

import {
  captureMessage,
  cleanupWorkspace,
  createSession,
  makeOptions,
  makeWorkspace,
  sessionInfo,
  textPart,
  userInfo,
} from './helpers.mjs';

test('init migrates legacy session, resume, and event files into SQLite', async () => {
  const workspace = makeWorkspace('lcm-legacy');
  const lcmDir = path.join(workspace, '.lcm');
  const sessionsDir = path.join(lcmDir, 'sessions');
  let store;

  try {
    mkdirSync(sessionsDir, { recursive: true });

    const legacySession = {
      sessionID: 'legacy',
      title: 'legacy',
      directory: workspace,
      rootSessionID: 'legacy',
      lineageDepth: 0,
      pinned: false,
      updatedAt: 2,
      eventCount: 1,
      messages: [
        {
          info: userInfo('legacy', 'm1', 2),
          parts: [textPart('legacy', 'm1', 'm1-p', 'legacy transcript body')],
        },
      ],
    };

    writeFileSync(path.join(sessionsDir, 'legacy.json'), JSON.stringify(legacySession, null, 2));
    writeFileSync(
      path.join(lcmDir, 'resume.json'),
      JSON.stringify({ legacy: 'legacy resume note' }, null, 2),
    );
    writeFileSync(
      path.join(lcmDir, 'events.jsonl'),
      `${JSON.stringify({
        id: 'evt-1',
        type: 'session.created',
        sessionID: 'legacy',
        timestamp: 2,
        payload: {
          type: 'session.created',
          properties: { info: sessionInfo(workspace, 'legacy', 2) },
        },
      })}\n`,
    );

    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    const stats = await store.stats();
    const describe = await store.describe({ sessionID: 'legacy' });
    const resume = await store.resume('legacy');
    const grep = await store.grep({ query: 'legacy transcript body', sessionID: 'legacy' });

    assert.equal(stats.sessionCount, 1);
    assert.equal(stats.totalEvents, 1);
    assert.match(describe, /Session: legacy/);
    assert.equal(resume, 'legacy resume note');
    assert.equal(grep[0].id, 'm1');
  } finally {
    store?.close();
    cleanupWorkspace(workspace);
  }
});

test('snapshot merge import preserves existing target sessions', async () => {
  const sourceWorkspace = makeWorkspace('lcm-merge-src');
  const targetWorkspace = makeWorkspace('lcm-merge-dst');
  const snapshotPath = path.join(sourceWorkspace, 'merge-snapshot.json');
  let source;
  let target;

  try {
    source = new SqliteLcmStore(sourceWorkspace, makeOptions());
    await source.init();
    await createSession(source, sourceWorkspace, 'source-session', 1);
    await captureMessage(source, {
      sessionID: 'source-session',
      messageID: 'm1',
      created: 2,
      parts: [textPart('source-session', 'm1', 'm1-p', 'source merge body')],
    });
    await source.exportSnapshot({ filePath: snapshotPath, scope: 'all' });

    target = new SqliteLcmStore(targetWorkspace, makeOptions());
    await target.init();
    await createSession(target, targetWorkspace, 'target-session', 3);
    await captureMessage(target, {
      sessionID: 'target-session',
      messageID: 'm2',
      created: 4,
      parts: [textPart('target-session', 'm2', 'm2-p', 'target local body')],
    });

    const importText = await target.importSnapshot({ filePath: snapshotPath, mode: 'merge' });
    const stats = await target.stats();
    const sourceResult = await target.grep({ query: 'source merge body', scope: 'all' });
    const targetResult = await target.grep({ query: 'target local body', scope: 'all' });

    assert.match(importText, /mode=merge/);
    assert.equal(stats.sessionCount, 2);
    assert.equal(sourceResult[0].sessionID, 'source-session');
    assert.equal(targetResult[0].sessionID, 'target-session');
  } finally {
    source?.close();
    target?.close();
    cleanupWorkspace(sourceWorkspace);
    cleanupWorkspace(targetWorkspace);
  }
});

test('snapshot import rebuilds stale imported summary graphs before reuse', async () => {
  const sourceWorkspace = makeWorkspace('lcm-stale-summary-src');
  const targetWorkspace = makeWorkspace('lcm-stale-summary-dst');
  const snapshotPath = path.join(sourceWorkspace, 'stale-summary-snapshot.json');
  let source;
  let target;

  try {
    source = new SqliteLcmStore(
      sourceWorkspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }),
    );
    await source.init();
    await createSession(source, sourceWorkspace, 'source-session', 1);
    await captureMessage(source, {
      sessionID: 'source-session',
      messageID: 'm1',
      created: 2,
      parts: [textPart('source-session', 'm1', 'm1-p', 'portable archived alpha')],
    });
    await captureMessage(source, {
      sessionID: 'source-session',
      messageID: 'm2',
      created: 3,
      parts: [textPart('source-session', 'm2', 'm2-p', 'portable archived beta')],
    });
    await captureMessage(source, {
      sessionID: 'source-session',
      messageID: 'm3',
      created: 4,
      parts: [textPart('source-session', 'm3', 'm3-p', 'portable archived gamma')],
    });
    await captureMessage(source, {
      sessionID: 'source-session',
      messageID: 'm4',
      created: 5,
      parts: [textPart('source-session', 'm4', 'm4-p', 'portable fresh tail')],
    });
    await source.buildCompactionContext('source-session');
    await source.exportSnapshot({ filePath: snapshotPath, scope: 'all' });

    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    assert.ok(snapshot.summary_nodes.length > 0);
    snapshot.summary_nodes[0].summary_text = 'stale imported summary';
    snapshot.summary_nodes[0].message_ids_json = JSON.stringify(['stale-message-id']);
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

    target = new SqliteLcmStore(
      targetWorkspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }),
    );
    await target.init();

    const importText = await target.importSnapshot({ filePath: snapshotPath, mode: 'replace' });
    const resume = await target.resume('source-session');
    const expanded = await target.expand({ sessionID: 'source-session' });
    const doctor = await target.doctor({ sessionID: 'source-session' });

    assert.match(importText, /mode=replace/);
    assert.match(resume, /portable archived alpha/);
    assert.match(expanded, /portable archived alpha/);
    assert.ok(!resume.includes('stale imported summary'));
    assert.ok(!expanded.includes('stale imported summary'));
    assert.match(doctor, /status=clean/);
  } finally {
    source?.close();
    target?.close();
    cleanupWorkspace(sourceWorkspace);
    cleanupWorkspace(targetWorkspace);
  }
});

test('snapshot paths can be outside the workspace (portable snapshots)', async () => {
  const workspace = makeWorkspace('lcm-snapshot-paths');
  const outsideWorkspace = makeWorkspace('lcm-snapshot-paths-outside');
  const outsideSnapshotPath = path.join(outsideWorkspace, 'snapshot.json');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    const snapshot = {
      version: 1,
      exportedAt: 1,
      scope: 'all',
      sessions: [],
      messages: [],
      parts: [],
      resumes: [],
      artifacts: [],
      artifact_blobs: [],
      summary_nodes: [],
      summary_edges: [],
      summary_state: [],
    };

    writeFileSync(outsideSnapshotPath, JSON.stringify(snapshot, null, 2));

    // Export to outside workspace should work (portable snapshots)
    const exportResult = await store.exportSnapshot({
      filePath: outsideSnapshotPath,
      scope: 'all',
    });
    assert.match(exportResult, /file=/);

    // Import from outside workspace should also work
    const importResult = await store.importSnapshot({
      filePath: outsideSnapshotPath,
      mode: 'replace',
    });
    assert.match(importResult, /file=/);
  } finally {
    store?.close();
    cleanupWorkspace(workspace);
    cleanupWorkspace(outsideWorkspace);
  }
});

test('snapshot relative paths resolve from the workspace and still block traversal', async () => {
  const workspace = makeWorkspace('lcm-snapshot-relative');
  const relativeSnapshotPath = path.join('.lcm', 'portable-snapshot.json');
  const absoluteSnapshotPath = path.join(workspace, relativeSnapshotPath);
  const traversalPath = path.join('..', 'outside-snapshot.json');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    await createSession(store, workspace, 'relative-session', 1);
    await captureMessage(store, {
      sessionID: 'relative-session',
      messageID: 'm1',
      created: 2,
      parts: [textPart('relative-session', 'm1', 'm1-p', 'relative snapshot body')],
    });

    const exportText = await store.exportSnapshot({
      filePath: relativeSnapshotPath,
      scope: 'all',
    });
    const importText = await store.importSnapshot({
      filePath: relativeSnapshotPath,
      mode: 'replace',
    });

    assert.match(
      exportText,
      new RegExp(`file=${absoluteSnapshotPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.match(
      importText,
      new RegExp(`file=${absoluteSnapshotPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );

    await assert.rejects(
      () => store.exportSnapshot({ filePath: traversalPath, scope: 'all' }),
      /Path must stay within the workspace/,
    );
    await assert.rejects(
      () => store.importSnapshot({ filePath: traversalPath, mode: 'replace' }),
      /Path must stay within the workspace/,
    );
  } finally {
    store?.close();
    cleanupWorkspace(workspace);
  }
});

test('snapshot import rejects malformed payloads', async () => {
  const workspace = makeWorkspace('lcm-snapshot-invalid');
  const snapshotPath = path.join(workspace, 'invalid-snapshot.json');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    writeFileSync(
      snapshotPath,
      JSON.stringify({ version: 1, exportedAt: 1, scope: 'all' }, null, 2),
    );

    await assert.rejects(
      () => store.importSnapshot({ filePath: snapshotPath, mode: 'replace' }),
      /Snapshot field "sessions" must be an array/,
    );
  } finally {
    store?.close();
    cleanupWorkspace(workspace);
  }
});

test('snapshot replace import rehomes a single-worktree export into the target workspace', async () => {
  const sourceWorkspace = makeWorkspace('lcm-rehome-src');
  const targetWorkspace = makeWorkspace('lcm-rehome-dst');
  const snapshotPath = path.join(sourceWorkspace, 'rehome-snapshot.json');
  let source;
  let target;

  try {
    source = new SqliteLcmStore(sourceWorkspace, makeOptions());
    await source.init();
    await createSession(source, sourceWorkspace, 'source-session', 1);
    await captureMessage(source, {
      sessionID: 'source-session',
      messageID: 'm1',
      created: 2,
      parts: [textPart('source-session', 'm1', 'm1-p', 'portable snapshot body')],
    });
    await source.exportSnapshot({ filePath: snapshotPath, scope: 'all' });

    target = new SqliteLcmStore(targetWorkspace, makeOptions());
    await target.init();

    const importText = await target.importSnapshot({ filePath: snapshotPath, mode: 'replace' });
    const describe = await target.describe({ sessionID: 'source-session' });
    const grep = await target.grep({
      query: 'portable snapshot body',
      sessionID: 'source-session',
      scope: 'worktree',
    });

    assert.match(importText, /mode=replace/);
    assert.match(importText, /worktree_mode=auto/);
    assert.match(importText, /effective_worktree_mode=current/);
    assert.match(importText, /source_worktrees=1/);
    assert.match(importText, /rehomed_sessions=1/);
    assert.match(
      describe,
      new RegExp(`Directory: ${targetWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.equal(grep[0].sessionID, 'source-session');
  } finally {
    source?.close();
    target?.close();
    cleanupWorkspace(sourceWorkspace);
    cleanupWorkspace(targetWorkspace);
  }
});

test('snapshot replace import preserves a single-worktree export when requested', async () => {
  const sourceWorkspace = makeWorkspace('lcm-preserve-src');
  const targetWorkspace = makeWorkspace('lcm-preserve-dst');
  const snapshotPath = path.join(sourceWorkspace, 'preserve-snapshot.json');
  let source;
  let target;

  try {
    source = new SqliteLcmStore(sourceWorkspace, makeOptions());
    await source.init();
    await createSession(source, sourceWorkspace, 'source-session', 1);
    await captureMessage(source, {
      sessionID: 'source-session',
      messageID: 'm1',
      created: 2,
      parts: [textPart('source-session', 'm1', 'm1-p', 'preserved snapshot body')],
    });
    await source.exportSnapshot({ filePath: snapshotPath, scope: 'all' });

    target = new SqliteLcmStore(targetWorkspace, makeOptions());
    await target.init();

    const importText = await target.importSnapshot({
      filePath: snapshotPath,
      mode: 'replace',
      worktreeMode: 'preserve',
    });
    const describe = await target.describe({ sessionID: 'source-session' });
    const grep = await target.grep({
      query: 'preserved snapshot body',
      sessionID: 'source-session',
      scope: 'all',
    });

    assert.match(importText, /worktree_mode=preserve/);
    assert.match(importText, /effective_worktree_mode=preserve/);
    assert.match(importText, /rehomed_sessions=0/);
    assert.match(
      describe,
      new RegExp(`Directory: ${sourceWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.equal(grep[0].sessionID, 'source-session');
  } finally {
    source?.close();
    target?.close();
    cleanupWorkspace(sourceWorkspace);
    cleanupWorkspace(targetWorkspace);
  }
});

test('snapshot replace import can force current-worktree remap for multi-worktree exports', async () => {
  const sourceWorkspace = makeWorkspace('lcm-force-current-src');
  const targetWorkspace = makeWorkspace('lcm-force-current-dst');
  const snapshotPath = path.join(sourceWorkspace, 'force-current-snapshot.json');
  const worktreeA = path.join(sourceWorkspace, 'worktree-a');
  const worktreeB = path.join(sourceWorkspace, 'worktree-b');
  let source;
  let target;

  try {
    source = new SqliteLcmStore(sourceWorkspace, makeOptions());
    await source.init();
    await createSession(source, worktreeA, 'session-a', 1);
    await createSession(source, worktreeB, 'session-b', 2);
    await captureMessage(source, {
      sessionID: 'session-a',
      messageID: 'm1',
      created: 3,
      parts: [textPart('session-a', 'm1', 'm1-p', 'multi worktree session a')],
    });
    await captureMessage(source, {
      sessionID: 'session-b',
      messageID: 'm2',
      created: 4,
      parts: [textPart('session-b', 'm2', 'm2-p', 'multi worktree session b')],
    });
    await source.exportSnapshot({ filePath: snapshotPath, scope: 'all' });

    target = new SqliteLcmStore(targetWorkspace, makeOptions());
    await target.init();

    const importText = await target.importSnapshot({
      filePath: snapshotPath,
      mode: 'replace',
      worktreeMode: 'current',
    });
    const describeA = await target.describe({ sessionID: 'session-a' });
    const describeB = await target.describe({ sessionID: 'session-b' });

    assert.match(importText, /worktree_mode=current/);
    assert.match(importText, /effective_worktree_mode=current/);
    assert.match(importText, /source_worktrees=2/);
    assert.match(importText, /rehomed_sessions=2/);
    assert.match(
      describeA,
      new RegExp(`Directory: ${targetWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.match(
      describeB,
      new RegExp(`Directory: ${targetWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  } finally {
    source?.close();
    target?.close();
    cleanupWorkspace(sourceWorkspace);
    cleanupWorkspace(targetWorkspace);
  }
});

test('snapshot merge import rejects colliding session IDs', async () => {
  const sourceWorkspace = makeWorkspace('lcm-collision-src');
  const targetWorkspace = makeWorkspace('lcm-collision-dst');
  const snapshotPath = path.join(sourceWorkspace, 'collision-snapshot.json');
  let source;
  let target;

  try {
    source = new SqliteLcmStore(sourceWorkspace, makeOptions());
    await source.init();
    await createSession(source, sourceWorkspace, 'shared-session', 1);
    await captureMessage(source, {
      sessionID: 'shared-session',
      messageID: 'm1',
      created: 2,
      parts: [textPart('shared-session', 'm1', 'm1-p', 'source shared body')],
    });
    await source.exportSnapshot({ filePath: snapshotPath, scope: 'all' });

    target = new SqliteLcmStore(targetWorkspace, makeOptions());
    await target.init();
    await createSession(target, targetWorkspace, 'shared-session', 3);
    await captureMessage(target, {
      sessionID: 'shared-session',
      messageID: 'm2',
      created: 4,
      parts: [textPart('shared-session', 'm2', 'm2-p', 'target shared body')],
    });

    await assert.rejects(
      () => target.importSnapshot({ filePath: snapshotPath, mode: 'merge' }),
      /Snapshot merge would overwrite existing sessions: shared-session/,
    );

    const targetResult = await target.grep({
      query: 'target shared body',
      sessionID: 'shared-session',
      scope: 'session',
    });
    const sourceResult = await target.grep({ query: 'source shared body', scope: 'all' });

    assert.equal(targetResult[0].sessionID, 'shared-session');
    assert.equal(sourceResult.length, 0);
  } finally {
    source?.close();
    target?.close();
    cleanupWorkspace(sourceWorkspace);
    cleanupWorkspace(targetWorkspace);
  }
});

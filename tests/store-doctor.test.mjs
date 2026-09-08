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

test('doctor reports and repairs summary drift, FTS drift, and orphan blobs', async () => {
  const workspace = makeWorkspace('lcm-doctor');
  let store;

  try {
    const options = makeOptions({
      freshTailMessages: 1,
      minMessagesForTransform: 4,
      largeContentThreshold: 40,
    });

    store = new SqliteLcmStore(workspace, options);
    await store.init();
    await createSession(store, workspace, 's1', 1);

    for (const [messageID, created, text] of [
      ['m1', 2, 'alpha archived note'],
      ['m2', 3, 'large blob repeated '.repeat(8)],
      ['m3', 4, 'bridge archived note'],
      ['m4', 5, 'fresh tail request'],
    ]) {
      await captureMessage(store, {
        sessionID: 's1',
        messageID,
        created,
        parts: [textPart('s1', messageID, `${messageID}-p`, text)],
      });
    }

    await store.buildCompactionContext('s1');
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 6,
        part: textPart('s1', 'm2', 'm2-p', 'short replacement'),
      },
    });

    const healthyBeforeCorruption = await store.doctor({ sessionID: 's1' });
    const preCorruptionStats = await store.stats();

    assert.match(healthyBeforeCorruption, /status=clean/);
    assert.equal(preCorruptionStats.orphanArtifactBlobCount, 1);

    store.close();

    store = new SqliteLcmStore(workspace, options);
    await store.init();
    await store.stats();

    const driftDb = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), {
      enableForeignKeyConstraints: false,
      timeout: 5000,
    });
    driftDb.exec("DELETE FROM summary_nodes WHERE session_id = 's1'");
    driftDb.exec("DELETE FROM message_fts WHERE message_id = 'm1'");
    driftDb.exec(
      "INSERT OR REPLACE INTO artifact_blobs (content_hash, content_text, char_count, created_at, orphaned_at) VALUES ('orphan-doctor-blob', 'orphaned artifact payload', 23, 7, 7)",
    );
    driftDb.exec(
      "UPDATE resumes SET note = 'LCM prototype resume note\nSummary roots:\n- sum_deadbeefcafe_l9_p9: stale' WHERE session_id = 's1'",
    );
    driftDb.close();

    const dryRun = await store.doctor({ sessionID: 's1' });

    assert.match(dryRun, /status=issues-found/);
    assert.match(dryRun, /summary_sessions_needing_rebuild=1/);
    assert.match(dryRun, /message_fts_delta=1/);
    assert.match(dryRun, /summary_fts_delta=-1/);
    assert.match(dryRun, /orphan_artifact_blobs=1/);
    assert.match(dryRun, /resume_sessions_needing_refresh=1/);

    const repaired = await store.doctor({ sessionID: 's1', apply: true });
    const clean = await store.doctor({ sessionID: 's1' });
    const grep = await store.grep({ query: 'alpha archived note', sessionID: 's1', limit: 3 });

    assert.match(repaired, /status=repaired/);
    assert.match(repaired, /applied_actions:/);
    assert.match(repaired, /refreshed 1 managed resume note/);
    assert.match(clean, /status=clean/);
    assert.match(clean, /issues=0/);
    assert.equal(grep[0]?.id, 'm1');
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('doctor apply deletes orphaned child rows, detached summary refs, and malformed events', async () => {
  const workspace = makeWorkspace('lcm-doctor-orphans');
  let store;

  try {
    const options = makeOptions({
      freshTailMessages: 1,
      minMessagesForTransform: 4,
    });

    store = new SqliteLcmStore(workspace, options);
    await store.init();
    await createSession(store, workspace, 's1', 1);
    for (const [messageID, created, text] of [
      ['m1', 2, 'alpha archived note'],
      ['m2', 3, 'beta archived note'],
      ['m3', 4, 'gamma archived note'],
      ['m4', 5, 'delta archived note'],
      ['m5', 6, 'epsilon archived note'],
      ['m6', 7, 'zeta archived note'],
      ['m7', 8, 'eta archived note'],
      ['m8', 9, 'theta fresh tail note'],
    ]) {
      await captureMessage(store, {
        sessionID: 's1',
        messageID,
        created,
        parts: [textPart('s1', messageID, `${messageID}-p`, text)],
      });
    }
    await store.buildCompactionContext('s1');
    store.close();

    const db = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), {
      enableForeignKeyConstraints: false,
      timeout: 5000,
    });
    db.exec(`
      INSERT INTO messages (message_id, session_id, created_at, info_json)
        VALUES ('gm1', 'ghost', 100, '{"role":"user"}');
      INSERT INTO parts (part_id, session_id, message_id, part_json)
        VALUES ('gp1', 'ghost', 'gm1', '{"type":"text","text":"orphan"}');
      INSERT INTO events (id, session_id, event_type, ts, payload_json)
        VALUES ('ev-orphan', 'ghost', 'message.updated', 100, '[message.updated]');
      INSERT INTO events (id, session_id, event_type, ts, payload_json)
        VALUES ('ev-malformed', 's1', 'message.created', 101, 'not json {');
      INSERT INTO events (id, session_id, event_type, ts, payload_json)
        VALUES (NULL, 's1', 'art_broken', 102, 'corrupt page row {');
      INSERT INTO message_fts (session_id, message_id, role, created_at, content)
        VALUES ('ghost', 'gm1', 'user', '100', 'orphaned indexed content');
      INSERT INTO summary_nodes (node_id, session_id, level, node_kind, start_index, end_index, message_ids_json, summary_text, strategy, created_at)
        VALUES ('extra-a', 's1', 0, 'leaf', 0, 0, '["m1"]', 'detached alpha', 'deterministic-v1', 103);
      INSERT INTO summary_nodes (node_id, session_id, level, node_kind, start_index, end_index, message_ids_json, summary_text, strategy, created_at)
        VALUES ('extra-b', 's1', 0, 'leaf', 1, 1, '["m2"]', 'detached beta', 'deterministic-v1', 103);
      INSERT INTO summary_edges (session_id, parent_id, child_id, child_position)
        VALUES ('ghost', 'extra-a', 'extra-b', 0);
      INSERT INTO summary_state (session_id, archived_count, latest_message_created, archived_signature, root_node_ids_json, updated_at)
        VALUES ('ghost', 0, 0, '', '[]', 103);
      INSERT INTO summary_fts (session_id, node_id, level, created_at, content)
        VALUES ('s1', 'extra-a', '0', '103', 'detached alpha');
      INSERT INTO summary_fts (session_id, node_id, level, created_at, content)
        VALUES ('s1', 'extra-b', '0', '103', 'detached beta');
    `);
    db.close();

    store = new SqliteLcmStore(workspace, options);
    await store.init();

    const dryRun = await store.doctor({ sessionID: 's1' });
    assert.match(dryRun, /status=issues-found/);
    assert.match(dryRun, /summary_sessions_needing_rebuild=0/);
    assert.match(dryRun, /orphan_summary_edges=0/);
    assert.match(dryRun, /foreign_key_violations=4/);
    assert.match(dryRun, /malformed_event_rows=2/);

    const repaired = await store.doctor({ sessionID: 's1', apply: true });
    assert.match(repaired, /status=repaired/);
    // gm1, gp1, ev-orphan, the detached summary edge, and the detached summary
    // state are all repaired during apply.
    assert.match(repaired, /deleted 5 orphaned child row\(s\)/);
    assert.match(repaired, /deleted 2 malformed event row\(s\)/);

    const scopedClean = await store.doctor({ sessionID: 's1' });
    const globalClean = await store.doctor();
    assert.match(scopedClean, /status=clean/);
    assert.match(globalClean, /status=clean/);
    assert.match(globalClean, /foreign_key_violations=0/);
    assert.match(globalClean, /malformed_event_rows=0/);
    assert.match(globalClean, /message_fts_delta=0/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

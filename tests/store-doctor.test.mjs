import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SqliteLcmStore } from "../dist/store.js";

import {
  captureMessage,
  cleanupWorkspace,
  createSession,
  makeOptions,
  makeWorkspace,
  textPart,
} from "./helpers.mjs";

test("doctor reports and repairs summary drift, FTS drift, and orphan blobs", async () => {
  const workspace = makeWorkspace("lcm-doctor");
  let store;

  try {
    const options = makeOptions({
      freshTailMessages: 1,
      minMessagesForTransform: 4,
      largeContentThreshold: 40,
    });

    store = new SqliteLcmStore(workspace, options);
    await store.init();
    await createSession(store, workspace, "s1", 1);

    for (const [messageID, created, text] of [
      ["m1", 2, "alpha archived note"],
      ["m2", 3, "large blob repeated ".repeat(8)],
      ["m3", 4, "bridge archived note"],
      ["m4", 5, "fresh tail request"],
    ]) {
      await captureMessage(store, {
        sessionID: "s1",
        messageID,
        created,
        parts: [textPart("s1", messageID, `${messageID}-p`, text)],
      });
    }

    await store.buildCompactionContext("s1");
    await store.capture({
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        time: 6,
        part: textPart("s1", "m2", "m2-p", "short replacement"),
      },
    });

    const healthyBeforeCorruption = await store.doctor({ sessionID: "s1" });
    const preCorruptionStats = await store.stats();

    assert.match(healthyBeforeCorruption, /status=clean/);
    assert.equal(preCorruptionStats.orphanArtifactBlobCount, 0);

    store.close();

    store = new SqliteLcmStore(workspace, options);
    await store.init();

    const driftDb = new DatabaseSync(path.join(workspace, ".lcm", "lcm.db"), {
      enableForeignKeyConstraints: false,
      timeout: 5000,
    });
    driftDb.exec("DELETE FROM summary_nodes WHERE session_id = 's1'");
    driftDb.exec("DELETE FROM message_fts WHERE message_id = 'm1'");
    driftDb.exec(
      "INSERT OR REPLACE INTO artifact_blobs (content_hash, content_text, char_count, created_at) VALUES ('orphan-doctor-blob', 'orphaned artifact payload', 23, 7)",
    );
    driftDb.close();

    const dryRun = await store.doctor({ sessionID: "s1" });

    assert.match(dryRun, /status=issues-found/);
    assert.match(dryRun, /summary_sessions_needing_rebuild=1/);
    assert.match(dryRun, /message_fts_delta=1/);
    assert.match(dryRun, /summary_fts_delta=-1/);
    assert.match(dryRun, /orphan_artifact_blobs=1/);

    const repaired = await store.doctor({ sessionID: "s1", apply: true });
    const clean = await store.doctor({ sessionID: "s1" });
    const grep = await store.grep({ query: "alpha archived note", sessionID: "s1", limit: 3 });

    assert.match(repaired, /status=repaired/);
    assert.match(repaired, /applied_actions:/);
    assert.match(clean, /status=clean/);
    assert.match(clean, /issues=0/);
    assert.equal(grep[0]?.id, "m1");
  } finally {
    store?.close();
    cleanupWorkspace(workspace);
  }
});

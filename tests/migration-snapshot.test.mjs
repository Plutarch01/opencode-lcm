import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SqliteLcmStore } from "../dist/store.js";

import {
  captureMessage,
  cleanupWorkspace,
  createSession,
  makeOptions,
  makeWorkspace,
  sessionInfo,
  textPart,
  userInfo,
} from "./helpers.mjs";

test("init migrates legacy session, resume, and event files into SQLite", async () => {
  const workspace = makeWorkspace("lcm-legacy");
  const lcmDir = path.join(workspace, ".lcm");
  const sessionsDir = path.join(lcmDir, "sessions");
  let store;

  try {
    mkdirSync(sessionsDir, { recursive: true });

    const legacySession = {
      sessionID: "legacy",
      title: "legacy",
      directory: workspace,
      rootSessionID: "legacy",
      lineageDepth: 0,
      pinned: false,
      updatedAt: 2,
      eventCount: 1,
      messages: [
        {
          info: userInfo("legacy", "m1", 2),
          parts: [textPart("legacy", "m1", "m1-p", "legacy transcript body")],
        },
      ],
    };

    writeFileSync(path.join(sessionsDir, "legacy.json"), JSON.stringify(legacySession, null, 2));
    writeFileSync(path.join(lcmDir, "resume.json"), JSON.stringify({ legacy: "legacy resume note" }, null, 2));
    writeFileSync(
      path.join(lcmDir, "events.jsonl"),
      `${JSON.stringify({
        id: "evt-1",
        type: "session.created",
        sessionID: "legacy",
        timestamp: 2,
        payload: { type: "session.created", properties: { info: sessionInfo(workspace, "legacy", 2) } },
      })}\n`,
    );

    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    const stats = await store.stats();
    const describe = await store.describe({ sessionID: "legacy" });
    const resume = await store.resume("legacy");
    const grep = await store.grep({ query: "legacy transcript body", sessionID: "legacy" });

    assert.equal(stats.sessionCount, 1);
    assert.equal(stats.totalEvents, 1);
    assert.match(describe, /Session: legacy/);
    assert.equal(resume, "legacy resume note");
    assert.equal(grep[0].id, "m1");
  } finally {
    store?.close();
    cleanupWorkspace(workspace);
  }
});

test("snapshot merge import preserves existing target sessions", async () => {
  const sourceWorkspace = makeWorkspace("lcm-merge-src");
  const targetWorkspace = makeWorkspace("lcm-merge-dst");
  const snapshotPath = path.join(sourceWorkspace, "merge-snapshot.json");
  let source;
  let target;

  try {
    source = new SqliteLcmStore(sourceWorkspace, makeOptions());
    await source.init();
    await createSession(source, sourceWorkspace, "source-session", 1);
    await captureMessage(source, {
      sessionID: "source-session",
      messageID: "m1",
      created: 2,
      parts: [textPart("source-session", "m1", "m1-p", "source merge body")],
    });
    await source.exportSnapshot({ filePath: snapshotPath, scope: "all" });

    target = new SqliteLcmStore(targetWorkspace, makeOptions());
    await target.init();
    await createSession(target, targetWorkspace, "target-session", 3);
    await captureMessage(target, {
      sessionID: "target-session",
      messageID: "m2",
      created: 4,
      parts: [textPart("target-session", "m2", "m2-p", "target local body")],
    });

    const importText = await target.importSnapshot({ filePath: snapshotPath, mode: "merge" });
    const stats = await target.stats();
    const sourceResult = await target.grep({ query: "source merge body", scope: "all" });
    const targetResult = await target.grep({ query: "target local body", scope: "all" });

    assert.match(importText, /mode=merge/);
    assert.equal(stats.sessionCount, 2);
    assert.equal(sourceResult[0].sessionID, "source-session");
    assert.equal(targetResult[0].sessionID, "target-session");
  } finally {
    source?.close();
    target?.close();
    cleanupWorkspace(sourceWorkspace);
    cleanupWorkspace(targetWorkspace);
  }
});

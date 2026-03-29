import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SqliteLcmStore } from "../dist/store.js";

function makeWorkspace(prefix) {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-`));
}

function makeOptions(overrides = {}) {
  return {
    interop: { contextMode: true, neverOverrideCompactionPrompt: true, ignoreToolPrefixes: ["ctx_"] },
    scopeDefaults: { grep: "session", describe: "session" },
    scopeProfiles: [],
    retention: { staleSessionDays: undefined, deletedSessionDays: 30, orphanBlobDays: 14 },
    compactContextLimit: 1200,
    systemHint: true,
    storeDir: ".lcm",
    freshTailMessages: 2,
    minMessagesForTransform: 4,
    summaryCharBudget: 900,
    partCharBudget: 120,
    largeContentThreshold: 80,
    artifactPreviewChars: 90,
    artifactViewChars: 1200,
    binaryPreviewProviders: ["fingerprint"],
    previewBytePeek: 8,
    ...overrides,
  };
}

function sessionInfo(directory, id, created, parentID) {
  return {
    id,
    slug: id,
    projectID: "p1",
    directory,
    parentID,
    title: id,
    version: "1",
    time: { created, updated: created },
  };
}

function userInfo(sessionID, id, created) {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-4.1" },
  };
}

test("init stamps the current schema version on disk", async () => {
  const workspace = makeWorkspace("lcm-schema-version");
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    const stats = await store.stats();
    assert.equal(stats.schemaVersion, 1);

    store.close();
    store = undefined;

    const db = new DatabaseSync(path.join(workspace, ".lcm", "lcm.db"), {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    const versionRow = db.prepare("PRAGMA user_version").get();
    db.close();

    assert.equal(Object.values(versionRow)[0], 1);
  } finally {
    store?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("init rejects newer on-disk schema versions", async () => {
  const workspace = makeWorkspace("lcm-schema-future");
  let store;

  try {
    mkdirSync(path.join(workspace, ".lcm"), { recursive: true });
    const db = new DatabaseSync(path.join(workspace, ".lcm", "lcm.db"), {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    db.exec("PRAGMA user_version = 99");
    db.close();

    store = new SqliteLcmStore(workspace, makeOptions());
    await assert.rejects(store.init(), /Unsupported store schema version: 99/);
  } finally {
    store?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("exports and imports a portable snapshot", async () => {
  const sourceDir = makeWorkspace("lcm-export-src");
  const targetDir = makeWorkspace("lcm-export-dst");
  const snapshotPath = path.join(sourceDir, "snapshot.json");
  let source;
  let target;

  try {
    source = new SqliteLcmStore(sourceDir, makeOptions());
    await source.init();
    await source.capture({ type: "session.created", properties: { sessionID: "root", info: sessionInfo(sourceDir, "root", 1) } });
    await source.capture({ type: "message.updated", properties: { sessionID: "root", info: userInfo("root", "m1", 2) } });
    await source.capture({ type: "message.part.updated", properties: { sessionID: "root", time: 2, part: { id: "p1", sessionID: "root", messageID: "m1", type: "text", text: "portable snapshot body" } } });
    await source.pinSession({ sessionID: "root", reason: "keep for export" });

    const exportText = await source.exportSnapshot({ filePath: snapshotPath, scope: "all" });
    assert.match(exportText, /sessions=1/);

    target = new SqliteLcmStore(targetDir, makeOptions());
    await target.init();
    const importText = await target.importSnapshot({ filePath: snapshotPath, mode: "replace" });
    assert.match(importText, /messages=1/);

    const describe = await target.describe({ sessionID: "root" });
    assert.match(describe, /Pinned: yes/);

    const grep = await target.grep({ query: "portable snapshot body", sessionID: "root" });
    assert.equal(grep[0]?.id, "m1");
  } finally {
    source?.close();
    target?.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("applies worktree scope defaults from profiles", async () => {
  const workspace = makeWorkspace("lcm-scope");
  let store;
  const options = makeOptions({
    scopeDefaults: { grep: "session", describe: "session" },
    scopeProfiles: [{ worktree: "c:/repo/a", grep: "worktree", describe: "root" }],
  });

  try {
    store = new SqliteLcmStore(workspace, options);
    await store.init();

    for (const [id, dir, parentID, created] of [
      ["rootA", "C:/repo/a", undefined, 1],
      ["branchA", "C:/repo/a", "rootA", 2],
      ["rootB", "C:/repo/a", undefined, 3],
    ]) {
      await store.capture({ type: "session.created", properties: { sessionID: id, info: sessionInfo(dir, id, created, parentID) } });
    }

    for (const [sessionID, id, created, text] of [
      ["branchA", "m1", 4, "worktree default query in branchA"],
      ["rootB", "m2", 5, "worktree default query in rootB"],
      ["rootA", "m3", 6, "root describe session"],
    ]) {
      await store.capture({ type: "message.updated", properties: { sessionID, info: userInfo(sessionID, id, created) } });
      await store.capture({ type: "message.part.updated", properties: { sessionID, time: created, part: { id: `${id}-p`, sessionID, messageID: id, type: "text", text } } });
    }

    const grep = await store.grep({ query: "worktree default query", sessionID: "branchA" });
    assert.deepEqual([...new Set(grep.map((item) => item.sessionID))].sort(), ["branchA", "rootB"]);

    const describe = await store.describe({ sessionID: "branchA" });
    assert.match(describe, /Scope: root/);
  } finally {
    store?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("message.updated preserves existing parts and search content", async () => {
  const workspace = makeWorkspace("lcm-message-update");
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    await store.capture({ type: "session.created", properties: { sessionID: "s1", info: sessionInfo(workspace, "s1", 1) } });
    await store.capture({ type: "message.updated", properties: { sessionID: "s1", info: userInfo("s1", "m1", 2) } });
    await store.capture({
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        time: 2,
        part: { id: "m1-p", sessionID: "s1", messageID: "m1", type: "text", text: "preserve this message body" },
      },
    });

    await store.capture({ type: "message.updated", properties: { sessionID: "s1", info: userInfo("s1", "m1", 3) } });

    const grep = await store.grep({ query: "preserve this message body", sessionID: "s1", limit: 3 });
    const describe = await store.describe({ sessionID: "s1" });

    assert.equal(grep[0]?.id, "m1");
    assert.match(describe, /preserve this message body/);
  } finally {
    store?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("message.removed drops reverted content from session memory and search", async () => {
  const workspace = makeWorkspace("lcm-message-removed");
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    await store.capture({ type: "session.created", properties: { sessionID: "s1", info: sessionInfo(workspace, "s1", 1) } });
    await store.capture({ type: "message.updated", properties: { sessionID: "s1", info: userInfo("s1", "m1", 2) } });
    await store.capture({
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        time: 2,
        part: {
          id: "m1-p",
          sessionID: "s1",
          messageID: "m1",
          type: "text",
          text: "reverted memory body ".repeat(8),
        },
      },
    });

    const before = await store.grep({ query: "reverted memory body", sessionID: "s1", limit: 3 });
    assert.equal(before[0]?.id, "m1");

    await store.capture({ type: "message.removed", properties: { sessionID: "s1", messageID: "m1" } });

    const after = await store.grep({ query: "reverted memory body", sessionID: "s1", limit: 3 });
    const describe = await store.describe({ sessionID: "s1" });
    const stats = await store.stats();

    assert.equal(after.length, 0);
    assert.ok(!describe.includes("reverted memory body"));
    assert.equal(stats.artifactCount, 0);
    assert.equal(stats.orphanArtifactBlobCount, 0);
  } finally {
    store?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("message.part.updated replaces externalized content without leaving stale artifacts", async () => {
  const workspace = makeWorkspace("lcm-message-part-replace");
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    await store.capture({ type: "session.created", properties: { sessionID: "s1", info: sessionInfo(workspace, "s1", 1) } });
    await store.capture({ type: "message.updated", properties: { sessionID: "s1", info: userInfo("s1", "m1", 2) } });
    await store.capture({
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        time: 2,
        part: { id: "m1-p", sessionID: "s1", messageID: "m1", type: "text", text: "large stale body ".repeat(12) },
      },
    });

    const before = await store.stats();
    assert.equal(before.artifactCount, 1);

    await store.capture({
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        time: 3,
        part: { id: "m1-p", sessionID: "s1", messageID: "m1", type: "text", text: "short replacement" },
      },
    });

    const grep = await store.grep({ query: "large stale body", sessionID: "s1", limit: 3 });
    const describe = await store.describe({ sessionID: "s1" });
    const after = await store.stats();

    assert.equal(grep.length, 0);
    assert.match(describe, /short replacement/);
    assert.equal(after.artifactCount, 0);
    assert.equal(after.orphanArtifactBlobCount, 0);
  } finally {
    store?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("message.part.delta is recorded without rewriting archived session state", async () => {
  const workspace = makeWorkspace("lcm-part-delta");
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    await store.capture({ type: "session.created", properties: { sessionID: "s1", info: sessionInfo(workspace, "s1", 1) } });
    await store.capture({ type: "message.updated", properties: { sessionID: "s1", info: userInfo("s1", "m1", 2) } });
    await store.capture({
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        time: 2,
        part: { id: "m1-p", sessionID: "s1", messageID: "m1", type: "text", text: "stable archived body" },
      },
    });

    const before = await store.describe({ sessionID: "s1" });
    await store.capture({
      type: "message.part.delta",
      properties: {
        sessionID: "s1",
        messageID: "m1",
        partID: "m1-p",
        field: "text",
        delta: " stream chunk",
      },
    });
    const after = await store.describe({ sessionID: "s1" });
    const stats = await store.stats();

    assert.equal(after, before);
    assert.equal(stats.eventTypes["message.part.delta"], 1);
  } finally {
    store?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("retention pruning skips pinned sessions and cleans orphan blobs", async () => {
  const workspace = makeWorkspace("lcm-retention");
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions({ retention: { staleSessionDays: undefined, deletedSessionDays: 30, orphanBlobDays: 14 } }));
    await store.init();

    await store.capture({ type: "session.created", properties: { sessionID: "keep", info: sessionInfo(workspace, "keep", 1) } });
    await store.capture({ type: "session.created", properties: { sessionID: "drop", info: sessionInfo(workspace, "drop", 2) } });

    for (const [sessionID, id, created, text] of [
      ["keep", "m1", 3, "keep pinned session"],
      ["drop", "m2", 4, "large blob ".repeat(20)],
    ]) {
      await store.capture({ type: "message.updated", properties: { sessionID, info: userInfo(sessionID, id, created) } });
      await store.capture({ type: "message.part.updated", properties: { sessionID, time: created, part: { id: `${id}-p`, sessionID, messageID: id, type: "text", text } } });
    }

    await store.pinSession({ sessionID: "keep", reason: "do not prune" });
    await store.capture({ type: "message.part.updated", properties: { sessionID: "drop", time: 5, part: { id: "m2-p", sessionID: "drop", messageID: "m2", type: "text", text: "short replacement" } } });

    const dryRun = await store.retentionPrune({ staleSessionDays: 0, orphanBlobDays: 0, apply: false });
    assert.match(dryRun, /deleted_session_candidates=0|stale_session_candidates=1/);
    assert.ok(!dryRun.includes("keep pinned session"));

    const applied = await store.retentionPrune({ staleSessionDays: 0, orphanBlobDays: 0, apply: true });
    assert.match(applied, /deleted_sessions=1/);

    const stats = await store.stats();
    assert.equal(stats.sessionCount, 1);
    assert.equal(stats.pinnedSessionCount, 1);
    assert.equal(stats.orphanArtifactBlobCount, 0);
  } finally {
    store?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

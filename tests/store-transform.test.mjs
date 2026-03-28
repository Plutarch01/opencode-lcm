import test from "node:test";
import assert from "node:assert/strict";

import { SqliteLcmStore } from "../dist/store.js";

import {
  captureMessage,
  cleanupWorkspace,
  conversationMessage,
  createSession,
  firstNodeID,
  makeOptions,
  makeWorkspace,
  textPart,
  toolCompletedPart,
} from "./helpers.mjs";

test("transformMessages is a no-op below the configured threshold", async () => {
  const workspace = makeWorkspace("lcm-transform-threshold");
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions({ minMessagesForTransform: 5, freshTailMessages: 2 }));
    await store.init();

    const messages = [
      conversationMessage({
        sessionID: "s1",
        messageID: "m1",
        created: 1,
        parts: [textPart("s1", "m1", "m1-p", "keep this intact")],
      }),
      conversationMessage({
        sessionID: "s1",
        messageID: "m2",
        created: 2,
        parts: [textPart("s1", "m2", "m2-p", "still visible")],
      }),
      conversationMessage({
        sessionID: "s1",
        messageID: "m3",
        created: 3,
        parts: [textPart("s1", "m3", "m3-p", "latest message")],
      }),
    ];

    const changed = await store.transformMessages(messages);

    assert.equal(changed, false);
    assert.equal(messages[0].parts[0].text, "keep this intact");
    assert.equal(messages[2].parts[0].text, "latest message");
  } finally {
    store?.close();
    cleanupWorkspace(workspace);
  }
});

test("transformMessages automatically injects relevant archived memory snippets", async () => {
  const workspace = makeWorkspace("lcm-auto-retrieval");
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }));
    await store.init();

    await createSession(store, workspace, "s1", 1);
    await captureMessage(store, {
      sessionID: "s1",
      messageID: "m1",
      created: 2,
      parts: [textPart("s1", "m1", "m1-p", "tenant mapping sqlite lives in the billing cache")],
    });
    await captureMessage(store, {
      sessionID: "s1",
      messageID: "m2",
      created: 3,
      role: "assistant",
      parts: [textPart("s1", "m2", "m2-p", "confirmed the tenant mapping sqlite flow")],
    });
    await captureMessage(store, {
      sessionID: "s1",
      messageID: "m3",
      created: 4,
      parts: [textPart("s1", "m3", "m3-p", "other archived context")],
    });
    await captureMessage(store, {
      sessionID: "s1",
      messageID: "m4",
      created: 5,
      parts: [textPart("s1", "m4", "m4-p", "tenant mapping sqlite")],
    });

    const messages = [
      conversationMessage({
        sessionID: "s1",
        messageID: "m1",
        created: 2,
        parts: [textPart("s1", "m1", "m1-p", "tenant mapping sqlite lives in the billing cache")],
      }),
      conversationMessage({
        sessionID: "s1",
        messageID: "m2",
        created: 3,
        role: "assistant",
        parts: [textPart("s1", "m2", "m2-p", "confirmed the tenant mapping sqlite flow")],
      }),
      conversationMessage({
        sessionID: "s1",
        messageID: "m3",
        created: 4,
        parts: [textPart("s1", "m3", "m3-p", "other archived context")],
      }),
      conversationMessage({
        sessionID: "s1",
        messageID: "m4",
        created: 5,
        parts: [textPart("s1", "m4", "m4-p", "tenant mapping sqlite")],
      }),
    ];

    const changed = await store.transformMessages(messages);
    const retrievalPart = messages[3].parts.find((part) => part.type === "text" && part.metadata?.opencodeLcm === "retrieved-context");
    const summaryPart = messages[3].parts.find((part) => part.type === "text" && part.metadata?.opencodeLcm === "archive-summary");

    assert.equal(changed, true);
    assert.ok(retrievalPart);
    assert.ok(summaryPart);
    assert.match(retrievalPart.text, /automatically recalled/);
    assert.match(retrievalPart.text, /message session=s1 id=m1/);
    assert.ok(!retrievalPart.text.includes("id=m4"));
  } finally {
    store?.close();
    cleanupWorkspace(workspace);
  }
});

test('automatic retrieval ignores framing words like "say" and recalls the archived location', async () => {
  const workspace = makeWorkspace("lcm-auto-retrieval-say");
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }));
    await store.init();

    await createSession(store, workspace, "s1", 1);
    await captureMessage(store, {
      sessionID: "s1",
      messageID: "m1",
      created: 2,
      parts: [textPart("s1", "m1", "m1-p", "tenant mapping sqlite lives in the billing cache near invoices_v2")],
    });
    await captureMessage(store, {
      sessionID: "s1",
      messageID: "m2",
      created: 3,
      role: "assistant",
      parts: [textPart("s1", "m2", "m2-p", "stored")],
    });
    await captureMessage(store, {
      sessionID: "s1",
      messageID: "m3",
      created: 4,
      parts: [textPart("s1", "m3", "m3-p", "another archived note")],
    });
    await captureMessage(store, {
      sessionID: "s1",
      messageID: "m4",
      created: 5,
      parts: [textPart("s1", "m4", "m4-p", "Where did I say tenant mapping sqlite lives? Reply only with the location.")],
    });

    const messages = [
      conversationMessage({
        sessionID: "s1",
        messageID: "m1",
        created: 2,
        parts: [textPart("s1", "m1", "m1-p", "tenant mapping sqlite lives in the billing cache near invoices_v2")],
      }),
      conversationMessage({
        sessionID: "s1",
        messageID: "m2",
        created: 3,
        role: "assistant",
        parts: [textPart("s1", "m2", "m2-p", "stored")],
      }),
      conversationMessage({
        sessionID: "s1",
        messageID: "m3",
        created: 4,
        parts: [textPart("s1", "m3", "m3-p", "another archived note")],
      }),
      conversationMessage({
        sessionID: "s1",
        messageID: "m4",
        created: 5,
        parts: [textPart("s1", "m4", "m4-p", "Where did I say tenant mapping sqlite lives? Reply only with the location.")],
      }),
    ];

    await store.transformMessages(messages);

    const retrievalPart = messages[3].parts.find((part) => part.type === "text" && part.metadata?.opencodeLcm === "retrieved-context");

    assert.ok(retrievalPart);
    assert.match(retrievalPart.text, /billing cache/);
    assert.ok(!retrievalPart.text.includes("session=s1 id=m4"));
  } finally {
    store?.close();
    cleanupWorkspace(workspace);
  }
});

test("transformMessages can disable automatic archived retrieval", async () => {
  const workspace = makeWorkspace("lcm-auto-retrieval-off");
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({
        freshTailMessages: 1,
        minMessagesForTransform: 4,
        automaticRetrieval: { enabled: false },
      }),
    );
    await store.init();
    await createSession(store, workspace, "s1", 1);

    const messages = [
      conversationMessage({
        sessionID: "s1",
        messageID: "m1",
        created: 1,
        parts: [textPart("s1", "m1", "m1-p", "tenant mapping sqlite lives in the billing cache")],
      }),
      conversationMessage({
        sessionID: "s1",
        messageID: "m2",
        created: 2,
        parts: [textPart("s1", "m2", "m2-p", "second archived note")],
      }),
      conversationMessage({
        sessionID: "s1",
        messageID: "m3",
        created: 3,
        parts: [textPart("s1", "m3", "m3-p", "third archived note")],
      }),
      conversationMessage({
        sessionID: "s1",
        messageID: "m4",
        created: 4,
        parts: [textPart("s1", "m4", "m4-p", "tenant mapping sqlite")],
      }),
    ];

    const changed = await store.transformMessages(messages);

    assert.equal(changed, true);
    assert.ok(!messages[3].parts.some((part) => part.type === "text" && part.metadata?.opencodeLcm === "retrieved-context"));
    assert.ok(messages[3].parts.some((part) => part.type === "text" && part.metadata?.opencodeLcm === "archive-summary"));
  } finally {
    store?.close();
    cleanupWorkspace(workspace);
  }
});

test("summary rebuilds when archived content changes and expand can target raw matches", async () => {
  const workspace = makeWorkspace("lcm-summary-rebuild");
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }));
    await store.init();

    await createSession(store, workspace, "s1", 1);
    await captureMessage(store, {
      sessionID: "s1",
      messageID: "m1",
      created: 2,
      parts: [textPart("s1", "m1", "m1-p", "alpha archived goal")],
    });
    await captureMessage(store, {
      sessionID: "s1",
      messageID: "m2",
      created: 3,
      parts: [toolCompletedPart("s1", "m2", "m2-p", "ctx_search", "infra trace")],
    });
    await captureMessage(store, {
      sessionID: "s1",
      messageID: "m3",
      created: 4,
      parts: [textPart("s1", "m3", "m3-p", "gamma archived note")],
    });
    await captureMessage(store, {
      sessionID: "s1",
      messageID: "m4",
      created: 5,
      parts: [textPart("s1", "m4", "m4-p", "fresh tail request")],
    });

    const firstNote = await store.buildCompactionContext("s1");
    const before = await store.expand({ sessionID: "s1" });

    assert.match(firstNote, /LCM prototype resume note/);
    assert.match(before, /alpha archived goal/);
    assert.ok(!before.includes("ctx_search"));

    await store.capture({
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        time: 2,
        part: textPart("s1", "m1", "m1-p", "omega revised goal"),
      },
    });

    const secondNote = await store.buildCompactionContext("s1");
    const resumed = await store.resume("s1");
    const after = await store.expand({ sessionID: "s1" });
    const nodeID = firstNodeID(after);

    assert.match(secondNote, /omega revised goal/);
    assert.match(resumed, /omega revised goal/);
    assert.match(after, /omega revised goal/);
    assert.ok(!after.includes("alpha archived goal"));
    assert.ok(nodeID);

    const targeted = await store.expand({ nodeID, query: "omega revised", includeRaw: true });
    assert.match(targeted, /Raw messages:/);
    assert.match(targeted, /m1/);
    assert.match(targeted, /omega revised goal/);
  } finally {
    store?.close();
    cleanupWorkspace(workspace);
  }
});

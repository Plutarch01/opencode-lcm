import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteLcmStore } from '../dist/store.js';
import {
  captureMessage,
  cleanupWorkspace,
  createSession,
  makeOptions,
  makeWorkspace,
  textPart,
  toolCompletedPart,
  toolErrorPart,
} from './helpers.mjs';

function makeStore(workspace, strategy) {
  return new SqliteLcmStore(
    workspace,
    makeOptions({
      freshTailMessages: 2,
      summaryV2: { strategy, perMessageBudget: 110 },
    }),
  );
}

async function getRoots(store, sessionID) {
  await store.prepareForRead();
  const session = store.readSessionSync(sessionID);
  return store.getSummaryRootsForSession(session);
}

async function seedSession(store, workspace, sessionID = 's1') {
  const trackedFilePart = {
    id: 'm3-p1',
    sessionID,
    messageID: 'm3',
    type: 'file',
    mime: 'text/typescript',
    filename: 'foo.ts',
    url: 'file:///src/foo.ts',
    source: {
      type: 'file',
      path: 'src/foo.ts',
      text: { value: 'export const foo = 1;\n', start: 0, end: 21 },
    },
  };

  await createSession(store, workspace, sessionID, 1);
  await captureMessage(store, {
    sessionID,
    messageID: 'm1',
    created: 2,
    role: 'user',
    parts: [textPart(sessionID, 'm1', 'm1-p1', 'Fix src/foo.ts summaries.')],
  });
  await captureMessage(store, {
    sessionID,
    messageID: 'm2',
    created: 3,
    role: 'assistant',
    parts: [textPart(sessionID, 'm2', 'm2-p1', 'Traced store flow.')],
  });
  await captureMessage(store, {
    sessionID,
    messageID: 'm3',
    created: 4,
    role: 'assistant',
    parts: [trackedFilePart],
  });
  await captureMessage(store, {
    sessionID,
    messageID: 'm4',
    created: 5,
    role: 'assistant',
    parts: [toolCompletedPart(sessionID, 'm4', 'm4-p1', 'bash', 'ok')],
  });
  await captureMessage(store, {
    sessionID,
    messageID: 'm5',
    created: 6,
    role: 'user',
    parts: [textPart(sessionID, 'm5', 'm5-p1', 'Test summary error handling.')],
  });
  await captureMessage(store, {
    sessionID,
    messageID: 'm6',
    created: 7,
    role: 'assistant',
    parts: [toolErrorPart(sessionID, 'm6', 'm6-p1', 'node', 'timeout')],
  });
  await captureMessage(store, {
    sessionID,
    messageID: 'm7',
    created: 8,
    role: 'user',
    parts: [
      textPart(
        sessionID,
        'm7',
        'm7-p1',
        'Fresh tail user anchor keeps the latest request outside the archive.',
      ),
    ],
  });
  await captureMessage(store, {
    sessionID,
    messageID: 'm8',
    created: 9,
    role: 'assistant',
    parts: [textPart(sessionID, 'm8', 'm8-p1', 'fresh tail assistant reply')],
  });
}

test('changing the summary strategy invalidates cached summary graph nodes', async () => {
  const workspace = makeWorkspace('summary-strategy-cache');
  let v1;
  let v2;

  try {
    v1 = makeStore(workspace, 'deterministic-v1');
    await v1.init();
    await seedSession(v1, workspace);

    const v1Roots = await getRoots(v1, 's1');
    const v1Summary = v1Roots[0].summaryText;

    assert.equal(v1Roots.length, 1);
    assert.equal(v1Roots[0].strategy, 'deterministic-v1');
    v1.close();
    v1 = undefined;

    v2 = makeStore(workspace, 'deterministic-v2');
    await v2.init();

    const v2Roots = await getRoots(v2, 's1');
    const v2Summary = v2Roots[0].summaryText;

    assert.equal(v2Roots.length, 1);
    assert.equal(v2Roots[0].strategy, 'deterministic-v2');
    assert.notEqual(v1Summary, v2Summary);
    assert.match(v2Summary, /6msg\(u:2\/a:4\)/);
    assert.match(v2Summary, /⚠err/);
    assert.doesNotMatch(v1Summary, /6msg\(u:2\/a:4\)/);
  } finally {
    v1?.close();
    v2?.close();
    await cleanupWorkspace(workspace);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteLcmStore } from '../dist/store.js';
import {
  captureMessage,
  cleanupWorkspace,
  createSession,
  filePart,
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

test('deterministic-v3 condenses internal nodes from child digests', async () => {
  const workspace = makeWorkspace('summary-strategy-v3');
  let v2;
  let v3;

  try {
    v2 = makeStore(workspace, 'deterministic-v2');
    await v2.init();
    await createSession(v2, workspace, 's1', 1);

    const filesByIndex = new Map([
      [3, 'alpha.ts'],
      [21, 'beta.ts'],
      [45, 'gamma.ts'],
    ]);
    for (let index = 1; index <= 54; index += 1) {
      const messageID = `m${index}`;
      const fileName = filesByIndex.get(index);
      const parts = [
        textPart(
          's1',
          messageID,
          `${messageID}-text`,
          index === 1 ? 'Preserve the multi-leaf file inventory.' : `summary message ${index}`,
        ),
      ];
      if (fileName) {
        parts.push(
          filePart(
            's1',
            messageID,
            `${messageID}-file`,
            `${workspace}/${fileName}`,
            `export const value${index} = ${index};`,
            'text/typescript',
          ),
        );
      }
      await captureMessage(v2, {
        sessionID: 's1',
        messageID,
        created: index + 1,
        role: index % 2 === 0 ? 'assistant' : 'user',
        parts,
      });
    }

    const v2Roots = await getRoots(v2, 's1');
    assert.equal(v2Roots[0].strategy, 'deterministic-v2');
    await v2.close();
    v2 = undefined;

    v3 = makeStore(workspace, 'deterministic-v3');
    await v3.init();
    const v3Roots = await getRoots(v3, 's1');

    assert.equal(v3Roots.length, 1);
    assert.equal(v3Roots[0].level, 2);
    assert.equal(v3Roots[0].strategy, 'deterministic-v3');
    assert.match(v3Roots[0].summaryText, /alpha\.ts/);
    assert.match(v3Roots[0].summaryText, /gamma\.ts/);
    assert.match(v3Roots[0].summaryText, /52msg\(u:26\/a:26\)/);
  } finally {
    await v2?.close();
    await v3?.close();
    await cleanupWorkspace(workspace);
  }
});

test('grep paginates, scopes to descendants, and annotates covering leaves', async () => {
  const workspace = makeWorkspace('summary-grep-scope');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({
        freshTailMessages: 0,
        summaryV2: { strategy: 'deterministic-v3', perMessageBudget: 110 },
      }),
    );
    await store.init();
    await createSession(store, workspace, 's1', 1);
    for (let index = 1; index <= 18; index += 1) {
      await captureMessage(store, {
        sessionID: 's1',
        messageID: `m${index}`,
        created: index + 1,
        role: index % 2 === 0 ? 'assistant' : 'user',
        parts: [
          textPart(
            's1',
            `m${index}`,
            `m${index}-text`,
            `pagination needle archived message ${index}`,
          ),
        ],
      });
    }

    const roots = await getRoots(store, 's1');
    const leaf = store.readSummaryChildrenSync(roots[0].nodeID)[0];
    const firstPage = await store.grep({
      query: 'pagination needle',
      sessionID: 's1',
      limit: 5,
      offset: 0,
    });
    const secondPage = await store.grep({
      query: 'pagination needle',
      sessionID: 's1',
      limit: 5,
      offset: 5,
    });
    const scoped = await store.grep({
      query: 'pagination needle',
      summaryID: leaf.nodeID,
      limit: 20,
    });
    const unknown = await store.grep({
      query: 'pagination needle',
      summaryID: 'missing-node',
    });
    const summaryOnly = await store.expand({ nodeID: leaf.nodeID });
    const withRaw = await store.expand({ nodeID: leaf.nodeID, includeRaw: true });

    assert.ok(Array.isArray(firstPage));
    assert.ok(Array.isArray(secondPage));
    assert.ok(Array.isArray(scoped));
    assert.equal(
      firstPage.some((left) =>
        secondPage.some((right) => `${left.type}:${left.id}` === `${right.type}:${right.id}`),
      ),
      false,
    );
    const scopedMessages = scoped.filter(
      (result) => result.type !== 'summary' && !result.type.startsWith('artifact:'),
    );
    assert.ok(scopedMessages.length > 0);
    assert.ok(scopedMessages.every((result) => leaf.messageIDs.includes(result.id)));
    assert.ok(scopedMessages.every((result) => result.nodeID === leaf.nodeID));
    assert.equal(unknown, 'Unknown summary node.');
    assert.doesNotMatch(summaryOnly, /Raw messages:/);
    assert.match(withRaw, /Raw messages:/);
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

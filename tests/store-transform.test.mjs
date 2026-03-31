import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SqliteLcmStore } from '../dist/store.js';

import {
  captureMessage,
  cleanupWorkspace,
  conversationMessage,
  createSession,
  firstNodeID,
  makeOptions,
  makeWorkspace,
  sessionInfo,
  textPart,
  toolCompletedPart,
} from './helpers.mjs';

test('transformMessages is a no-op below the configured threshold', async () => {
  const workspace = makeWorkspace('lcm-transform-threshold');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ minMessagesForTransform: 5, freshTailMessages: 2 }),
    );
    await store.init();

    const messages = [
      conversationMessage({
        sessionID: 's1',
        messageID: 'm1',
        created: 1,
        parts: [textPart('s1', 'm1', 'm1-p', 'keep this intact')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm2',
        created: 2,
        parts: [textPart('s1', 'm2', 'm2-p', 'still visible')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm3',
        created: 3,
        parts: [textPart('s1', 'm3', 'm3-p', 'latest message')],
      }),
    ];

    const changed = await store.transformMessages(messages);

    assert.equal(changed, false);
    assert.equal(messages[0].parts[0].text, 'keep this intact');
    assert.equal(messages[2].parts[0].text, 'latest message');
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('transformMessages automatically injects relevant archived memory snippets', async () => {
  const workspace = makeWorkspace('lcm-auto-retrieval');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }),
    );
    await store.init();

    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [textPart('s1', 'm1', 'm1-p', 'tenant mapping sqlite lives in the billing cache')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm2',
      created: 3,
      role: 'assistant',
      parts: [textPart('s1', 'm2', 'm2-p', 'confirmed the tenant mapping sqlite flow')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm3',
      created: 4,
      parts: [textPart('s1', 'm3', 'm3-p', 'other archived context')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm4',
      created: 5,
      parts: [textPart('s1', 'm4', 'm4-p', 'tenant mapping sqlite')],
    });

    const messages = [
      conversationMessage({
        sessionID: 's1',
        messageID: 'm1',
        created: 2,
        parts: [textPart('s1', 'm1', 'm1-p', 'tenant mapping sqlite lives in the billing cache')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm2',
        created: 3,
        role: 'assistant',
        parts: [textPart('s1', 'm2', 'm2-p', 'confirmed the tenant mapping sqlite flow')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm3',
        created: 4,
        parts: [textPart('s1', 'm3', 'm3-p', 'other archived context')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm4',
        created: 5,
        parts: [textPart('s1', 'm4', 'm4-p', 'tenant mapping sqlite')],
      }),
    ];

    const changed = await store.transformMessages(messages);
    const retrievalPart = messages[3].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'retrieved-context',
    );
    const summaryPart = messages[3].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'archive-summary',
    );

    assert.equal(changed, true);
    assert.ok(retrievalPart);
    assert.ok(summaryPart);
    assert.match(retrievalPart.text, /automatically recalled/);
    assert.match(retrievalPart.text, /Recall telemetry: queries=/);
    assert.match(retrievalPart.text, /message session=s1 id=m1/);
    assert.ok(!retrievalPart.text.includes('id=m4'));
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('automatic retrieval ignores framing words like "say" and recalls the archived location', async () => {
  const workspace = makeWorkspace('lcm-auto-retrieval-say');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }),
    );
    await store.init();

    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [
        textPart(
          's1',
          'm1',
          'm1-p',
          'tenant mapping sqlite lives in the billing cache near invoices_v2',
        ),
      ],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm2',
      created: 3,
      role: 'assistant',
      parts: [textPart('s1', 'm2', 'm2-p', 'stored')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm3',
      created: 4,
      parts: [textPart('s1', 'm3', 'm3-p', 'another archived note')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm4',
      created: 5,
      parts: [
        textPart(
          's1',
          'm4',
          'm4-p',
          'Where did I say tenant mapping sqlite lives? Reply only with the location.',
        ),
      ],
    });

    const messages = [
      conversationMessage({
        sessionID: 's1',
        messageID: 'm1',
        created: 2,
        parts: [
          textPart(
            's1',
            'm1',
            'm1-p',
            'tenant mapping sqlite lives in the billing cache near invoices_v2',
          ),
        ],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm2',
        created: 3,
        role: 'assistant',
        parts: [textPart('s1', 'm2', 'm2-p', 'stored')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm3',
        created: 4,
        parts: [textPart('s1', 'm3', 'm3-p', 'another archived note')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm4',
        created: 5,
        parts: [
          textPart(
            's1',
            'm4',
            'm4-p',
            'Where did I say tenant mapping sqlite lives? Reply only with the location.',
          ),
        ],
      }),
    ];

    await store.transformMessages(messages);

    const retrievalPart = messages[3].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'retrieved-context',
    );

    assert.ok(retrievalPart);
    assert.match(retrievalPart.text, /billing cache/);
    assert.ok(!retrievalPart.text.includes('session=s1 id=m4'));
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('automatic retrieval can build recall queries from later intent tokens', async () => {
  const workspace = makeWorkspace('lcm-auto-retrieval-windows');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }),
    );
    await store.init();

    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [
        textPart(
          's1',
          'm1',
          'm1-p',
          'tenant mapping sqlite lives in the billing cache near invoices_v2',
        ),
      ],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm2',
      created: 3,
      role: 'assistant',
      parts: [textPart('s1', 'm2', 'm2-p', 'stored')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm3',
      created: 4,
      parts: [textPart('s1', 'm3', 'm3-p', 'another archived note')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm4',
      created: 5,
      parts: [textPart('s1', 'm4', 'm4-p', 'legacy adapter tenant mapping sqlite')],
    });

    const messages = [
      conversationMessage({
        sessionID: 's1',
        messageID: 'm1',
        created: 2,
        parts: [
          textPart(
            's1',
            'm1',
            'm1-p',
            'tenant mapping sqlite lives in the billing cache near invoices_v2',
          ),
        ],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm2',
        created: 3,
        role: 'assistant',
        parts: [textPart('s1', 'm2', 'm2-p', 'stored')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm3',
        created: 4,
        parts: [textPart('s1', 'm3', 'm3-p', 'another archived note')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm4',
        created: 5,
        parts: [textPart('s1', 'm4', 'm4-p', 'legacy adapter tenant mapping sqlite')],
      }),
    ];

    await store.transformMessages(messages);

    const retrievalPart = messages[3].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'retrieved-context',
    );

    assert.ok(retrievalPart);
    assert.match(retrievalPart.text, /billing cache/);
    assert.match(retrievalPart.text, /queries=.*tenant mapping sqlite/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('automatic retrieval ignores pasted system reminders on low-signal confirmation turns', async () => {
  const workspace = makeWorkspace('lcm-auto-retrieval-confirmation-noise');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }),
    );
    await store.init();

    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [
        textPart(
          's1',
          'm1',
          'm1-p',
          'tenant mapping sqlite lives in the billing cache near invoices_v2',
        ),
      ],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm2',
      created: 3,
      role: 'assistant',
      parts: [textPart('s1', 'm2', 'm2-p', 'stored')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm3',
      created: 4,
      parts: [textPart('s1', 'm3', 'm3-p', 'another archived note')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm4',
      created: 5,
      parts: [
        textPart(
          's1',
          'm4',
          'm4-p',
          '<system-reminder>opencode-lcm automatically recalled 1 archived context hit(s). Recall telemetry: queries=one thing revert message Recalled context: - message session=s1 id=m1: tenant mapping sqlite Treat recalled archive as supporting context.</system-reminder> go ahead <system-reminder>Your operational mode has changed from plan to build.</system-reminder>',
        ),
      ],
    });

    const messages = [
      conversationMessage({
        sessionID: 's1',
        messageID: 'm1',
        created: 2,
        parts: [
          textPart(
            's1',
            'm1',
            'm1-p',
            'tenant mapping sqlite lives in the billing cache near invoices_v2',
          ),
        ],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm2',
        created: 3,
        role: 'assistant',
        parts: [textPart('s1', 'm2', 'm2-p', 'stored')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm3',
        created: 4,
        parts: [textPart('s1', 'm3', 'm3-p', 'another archived note')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm4',
        created: 5,
        parts: [
          textPart(
            's1',
            'm4',
            'm4-p',
            '<system-reminder>opencode-lcm automatically recalled 1 archived context hit(s). Recall telemetry: queries=one thing revert message Recalled context: - message session=s1 id=m1: tenant mapping sqlite Treat recalled archive as supporting context.</system-reminder> go ahead <system-reminder>Your operational mode has changed from plan to build.</system-reminder>',
          ),
        ],
      }),
    ];

    await store.transformMessages(messages);

    const retrievalPart = messages[3].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'retrieved-context',
    );
    const summaryPart = messages[3].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'archive-summary',
    );

    assert.equal(retrievalPart, undefined);
    assert.ok(summaryPart);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('automatic retrieval ignores low-signal commit turns even with noisy nearby history', async () => {
  const workspace = makeWorkspace('lcm-auto-retrieval-commit-noise');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 3, minMessagesForTransform: 5 }),
    );
    await store.init();

    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [
        textPart(
          's1',
          'm1',
          'm1-p',
          'tenant mapping sqlite lives in the billing cache near invoices_v2',
        ),
      ],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm2',
      created: 3,
      role: 'assistant',
      parts: [textPart('s1', 'm2', 'm2-p', 'stored')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm3',
      created: 4,
      parts: [textPart('s1', 'm3', 'm3-p', 'what do you suggest?')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm4',
      created: 5,
      role: 'assistant',
      parts: [textPart('s1', 'm4', 'm4-p', 'I suggest shipping after one more verification pass')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm5',
      created: 6,
      parts: [
        textPart(
          's1',
          'm5',
          'm5-p',
          '<system-reminder>opencode-lcm automatically recalled 3 archived context hit(s) relevant to the current turn (scope=session). Recall telemetry: queries=commit system reminder operational | commit system reminder | commit system | system reminder operational mode Recalled context: - message session=s1 id=m3: what do you suggest? - artifact session=s1 id=art_meta (artifact:tool): supporting context </[system]-[reminder]> <system-reminder>Your operational mode has changed from plan to build.</system-reminder> commit',
        ),
      ],
    });

    const messages = [
      conversationMessage({
        sessionID: 's1',
        messageID: 'm1',
        created: 2,
        parts: [
          textPart(
            's1',
            'm1',
            'm1-p',
            'tenant mapping sqlite lives in the billing cache near invoices_v2',
          ),
        ],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm2',
        created: 3,
        role: 'assistant',
        parts: [textPart('s1', 'm2', 'm2-p', 'stored')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm3',
        created: 4,
        parts: [textPart('s1', 'm3', 'm3-p', 'what do you suggest?')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm4',
        created: 5,
        role: 'assistant',
        parts: [
          textPart('s1', 'm4', 'm4-p', 'I suggest shipping after one more verification pass'),
        ],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm5',
        created: 6,
        parts: [
          textPart(
            's1',
            'm5',
            'm5-p',
            '<system-reminder>opencode-lcm automatically recalled 3 archived context hit(s) relevant to the current turn (scope=session). Recall telemetry: queries=commit system reminder operational | commit system reminder | commit system | system reminder operational mode Recalled context: - message session=s1 id=m3: what do you suggest? - artifact session=s1 id=art_meta (artifact:tool): supporting context </[system]-[reminder]> <system-reminder>Your operational mode has changed from plan to build.</system-reminder> commit',
          ),
        ],
      }),
    ];

    await store.transformMessages(messages);

    const retrievalPart = messages[4].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'retrieved-context',
    );
    const summaryPart = messages[4].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'archive-summary',
    );

    assert.equal(retrievalPart, undefined);
    assert.ok(summaryPart);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('automatic retrieval ignores meta-heavy artifact snippets when real message hits exist', async () => {
  const workspace = makeWorkspace('lcm-auto-retrieval-artifact-noise');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4, largeContentThreshold: 40 }),
    );
    await store.init();

    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [
        textPart(
          's1',
          'm1',
          'm1-p',
          'tenant mapping sqlite lives in the billing cache near invoices_v2',
        ),
      ],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm2',
      created: 3,
      role: 'assistant',
      parts: [
        toolCompletedPart(
          's1',
          'm2',
          'm2-p',
          'lcm_expand',
          '<system-reminder>Recall telemetry: queries=tenant mapping sqlite Recalled context: artifact session=s1 tenant mapping sqlite lives in the billing cache near invoices_v2</system-reminder>',
        ),
      ],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm3',
      created: 4,
      parts: [textPart('s1', 'm3', 'm3-p', 'another archived note')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm4',
      created: 5,
      parts: [textPart('s1', 'm4', 'm4-p', 'Where did tenant mapping sqlite live again?')],
    });

    const messages = [
      conversationMessage({
        sessionID: 's1',
        messageID: 'm1',
        created: 2,
        parts: [
          textPart(
            's1',
            'm1',
            'm1-p',
            'tenant mapping sqlite lives in the billing cache near invoices_v2',
          ),
        ],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm2',
        created: 3,
        role: 'assistant',
        parts: [
          toolCompletedPart(
            's1',
            'm2',
            'm2-p',
            'lcm_expand',
            '<system-reminder>Recall telemetry: queries=tenant mapping sqlite Recalled context: artifact session=s1 tenant mapping sqlite lives in the billing cache near invoices_v2</system-reminder>',
          ),
        ],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm3',
        created: 4,
        parts: [textPart('s1', 'm3', 'm3-p', 'another archived note')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm4',
        created: 5,
        parts: [textPart('s1', 'm4', 'm4-p', 'Where did tenant mapping sqlite live again?')],
      }),
    ];

    await store.transformMessages(messages);

    const retrievalPart = messages[3].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'retrieved-context',
    );

    assert.ok(retrievalPart);
    assert.match(retrievalPart.text, /message session=s1 id=m1/);
    assert.ok(!retrievalPart.text.includes('artifact:tool'));
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('automatic retrieval escalates from session to worktree when nearby archive is empty', async () => {
  const workspace = makeWorkspace('lcm-auto-retrieval-worktree');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 3 }),
    );
    await store.init();

    await createSession(store, workspace, 'older', 1);
    await captureMessage(store, {
      sessionID: 'older',
      messageID: 'om1',
      created: 2,
      parts: [
        textPart(
          'older',
          'om1',
          'om1-p',
          'tenant mapping sqlite lives in the billing cache near invoices_v2',
        ),
      ],
    });

    await createSession(store, workspace, 'current', 10);
    await captureMessage(store, {
      sessionID: 'current',
      messageID: 'm1',
      created: 11,
      parts: [textPart('current', 'm1', 'm1-p', 'current session unrelated archived note')],
    });
    await captureMessage(store, {
      sessionID: 'current',
      messageID: 'm2',
      created: 12,
      role: 'assistant',
      parts: [textPart('current', 'm2', 'm2-p', 'acknowledged')],
    });
    await captureMessage(store, {
      sessionID: 'current',
      messageID: 'm3',
      created: 13,
      parts: [textPart('current', 'm3', 'm3-p', 'Where did tenant mapping sqlite live again?')],
    });

    const messages = [
      conversationMessage({
        sessionID: 'current',
        messageID: 'm1',
        created: 11,
        parts: [textPart('current', 'm1', 'm1-p', 'current session unrelated archived note')],
      }),
      conversationMessage({
        sessionID: 'current',
        messageID: 'm2',
        created: 12,
        role: 'assistant',
        parts: [textPart('current', 'm2', 'm2-p', 'acknowledged')],
      }),
      conversationMessage({
        sessionID: 'current',
        messageID: 'm3',
        created: 13,
        parts: [textPart('current', 'm3', 'm3-p', 'Where did tenant mapping sqlite live again?')],
      }),
    ];

    await store.transformMessages(messages);

    const retrievalPart = messages[2].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'retrieved-context',
    );

    assert.ok(retrievalPart);
    assert.match(retrievalPart.text, /scope=session -> worktree/);
    assert.match(retrievalPart.text, /Recall telemetry: raw_results=/);
    assert.match(retrievalPart.text, /message session=older id=om1/);
    assert.match(retrievalPart.text, /billing cache/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('automatic retrieval respects configured scope order', async () => {
  const workspace = makeWorkspace('lcm-auto-retrieval-order');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({
        freshTailMessages: 1,
        minMessagesForTransform: 2,
        automaticRetrieval: { scopeOrder: ['worktree'] },
      }),
    );
    await store.init();

    await createSession(store, workspace, 'older', 1);
    await captureMessage(store, {
      sessionID: 'older',
      messageID: 'om1',
      created: 2,
      parts: [
        textPart(
          'older',
          'om1',
          'om1-p',
          'tenant mapping sqlite lives in the billing cache near invoices_v2',
        ),
      ],
    });

    await createSession(store, workspace, 'current', 10);
    await captureMessage(store, {
      sessionID: 'current',
      messageID: 'm1',
      created: 11,
      parts: [textPart('current', 'm1', 'm1-p', 'current session unrelated archived note')],
    });
    await captureMessage(store, {
      sessionID: 'current',
      messageID: 'm2',
      created: 12,
      parts: [textPart('current', 'm2', 'm2-p', 'Where did tenant mapping sqlite live again?')],
    });

    const messages = [
      conversationMessage({
        sessionID: 'current',
        messageID: 'm1',
        created: 11,
        parts: [textPart('current', 'm1', 'm1-p', 'current session unrelated archived note')],
      }),
      conversationMessage({
        sessionID: 'current',
        messageID: 'm2',
        created: 12,
        parts: [textPart('current', 'm2', 'm2-p', 'Where did tenant mapping sqlite live again?')],
      }),
    ];

    await store.transformMessages(messages);

    const retrievalPart = messages[1].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'retrieved-context',
    );

    assert.ok(retrievalPart);
    assert.match(retrievalPart.text, /scope=worktree/);
    assert.ok(!retrievalPart.text.includes('scope=session'));
    assert.match(retrievalPart.text, /message session=older id=om1/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('automatic retrieval can skip a scope with a zero budget', async () => {
  const workspace = makeWorkspace('lcm-auto-retrieval-budget-skip');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({
        freshTailMessages: 1,
        minMessagesForTransform: 2,
        automaticRetrieval: {
          scopeOrder: ['session', 'worktree'],
          scopeBudgets: { session: 0, worktree: 6 },
          stop: { targetHits: 1 },
        },
      }),
    );
    await store.init();

    await createSession(store, workspace, 'older', 1);
    await captureMessage(store, {
      sessionID: 'older',
      messageID: 'om1',
      created: 2,
      parts: [
        textPart(
          'older',
          'om1',
          'om1-p',
          'tenant mapping sqlite lives in the billing cache near invoices_v2',
        ),
      ],
    });

    await createSession(store, workspace, 'current', 10);
    await captureMessage(store, {
      sessionID: 'current',
      messageID: 'm1',
      created: 11,
      parts: [textPart('current', 'm1', 'm1-p', 'current session unrelated archived note')],
    });
    await captureMessage(store, {
      sessionID: 'current',
      messageID: 'm2',
      created: 12,
      parts: [textPart('current', 'm2', 'm2-p', 'Where did tenant mapping sqlite live again?')],
    });

    const messages = [
      conversationMessage({
        sessionID: 'current',
        messageID: 'm1',
        created: 11,
        parts: [textPart('current', 'm1', 'm1-p', 'current session unrelated archived note')],
      }),
      conversationMessage({
        sessionID: 'current',
        messageID: 'm2',
        created: 12,
        parts: [textPart('current', 'm2', 'm2-p', 'Where did tenant mapping sqlite live again?')],
      }),
    ];

    await store.transformMessages(messages);

    const retrievalPart = messages[1].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'retrieved-context',
    );

    assert.ok(retrievalPart);
    assert.match(retrievalPart.text, /scope=worktree/);
    assert.match(retrievalPart.text, /stop_reason=target-hits-reached/);
    assert.match(
      retrievalPart.text,
      /scope_stats=session:hits=0,raw=0,budget=0 \| worktree:hits=1/,
    );
    assert.match(retrievalPart.text, /message session=older id=om1/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('automatic retrieval can stop after the first scope with hits', async () => {
  const workspace = makeWorkspace('lcm-auto-retrieval-stop-first-scope');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({
        freshTailMessages: 1,
        minMessagesForTransform: 3,
        automaticRetrieval: {
          scopeOrder: ['session', 'worktree'],
          stop: { targetHits: 3, stopOnFirstScopeWithHits: true },
        },
      }),
    );
    await store.init();

    await createSession(store, workspace, 'older', 1);
    await captureMessage(store, {
      sessionID: 'older',
      messageID: 'om1',
      created: 2,
      parts: [
        textPart(
          'older',
          'om1',
          'om1-p',
          'tenant mapping sqlite lives in the remote fallback cache',
        ),
      ],
    });

    await createSession(store, workspace, 'current', 10);
    await captureMessage(store, {
      sessionID: 'current',
      messageID: 'm1',
      created: 11,
      parts: [
        textPart(
          'current',
          'm1',
          'm1-p',
          'tenant mapping sqlite lives in the billing cache near invoices_v2',
        ),
      ],
    });
    await captureMessage(store, {
      sessionID: 'current',
      messageID: 'm2',
      created: 12,
      role: 'assistant',
      parts: [textPart('current', 'm2', 'm2-p', 'acknowledged')],
    });
    await captureMessage(store, {
      sessionID: 'current',
      messageID: 'm3',
      created: 13,
      parts: [textPart('current', 'm3', 'm3-p', 'Where did tenant mapping sqlite live again?')],
    });

    const messages = [
      conversationMessage({
        sessionID: 'current',
        messageID: 'm1',
        created: 11,
        parts: [
          textPart(
            'current',
            'm1',
            'm1-p',
            'tenant mapping sqlite lives in the billing cache near invoices_v2',
          ),
        ],
      }),
      conversationMessage({
        sessionID: 'current',
        messageID: 'm2',
        created: 12,
        role: 'assistant',
        parts: [textPart('current', 'm2', 'm2-p', 'acknowledged')],
      }),
      conversationMessage({
        sessionID: 'current',
        messageID: 'm3',
        created: 13,
        parts: [textPart('current', 'm3', 'm3-p', 'Where did tenant mapping sqlite live again?')],
      }),
    ];

    await store.transformMessages(messages);

    const retrievalPart = messages[2].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'retrieved-context',
    );

    assert.ok(retrievalPart);
    assert.match(retrievalPart.text, /scope=session/);
    assert.ok(!retrievalPart.text.includes('scope=session -> worktree'));
    assert.match(retrievalPart.text, /stop_reason=first-scope-hit/);
    assert.match(retrievalPart.text, /message session=current id=m1/);
    assert.ok(!retrievalPart.text.includes('session=older id=om1'));
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('transformMessages can disable automatic archived retrieval', async () => {
  const workspace = makeWorkspace('lcm-auto-retrieval-off');
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
    await createSession(store, workspace, 's1', 1);

    const messages = [
      conversationMessage({
        sessionID: 's1',
        messageID: 'm1',
        created: 1,
        parts: [textPart('s1', 'm1', 'm1-p', 'tenant mapping sqlite lives in the billing cache')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm2',
        created: 2,
        parts: [textPart('s1', 'm2', 'm2-p', 'second archived note')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm3',
        created: 3,
        parts: [textPart('s1', 'm3', 'm3-p', 'third archived note')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm4',
        created: 4,
        parts: [textPart('s1', 'm4', 'm4-p', 'tenant mapping sqlite')],
      }),
    ];

    const changed = await store.transformMessages(messages);

    assert.equal(changed, true);
    assert.ok(
      !messages[3].parts.some(
        (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'retrieved-context',
      ),
    );
    assert.ok(
      messages[3].parts.some(
        (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'archive-summary',
      ),
    );
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('transformMessages anchors synthetic context on the latest user when the recent tail is assistant-only', async () => {
  const workspace = makeWorkspace('lcm-transform-latest-user');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({
        freshTailMessages: 2,
        minMessagesForTransform: 5,
        automaticRetrieval: { enabled: false },
      }),
    );
    await store.init();
    await createSession(store, workspace, 's1', 1);

    const messages = [
      conversationMessage({
        sessionID: 's1',
        messageID: 'm1',
        created: 1,
        parts: [textPart('s1', 'm1', 'm1-p', 'older archived message')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm2',
        created: 2,
        role: 'assistant',
        parts: [textPart('s1', 'm2', 'm2-p', 'older assistant note')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm3',
        created: 3,
        parts: [textPart('s1', 'm3', 'm3-p', 'current user request')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm4',
        created: 4,
        role: 'assistant',
        parts: [toolCompletedPart('s1', 'm4', 'm4-p', 'lcm_grep', 'first tool output')],
      }),
      conversationMessage({
        sessionID: 's1',
        messageID: 'm5',
        created: 5,
        role: 'assistant',
        parts: [toolCompletedPart('s1', 'm5', 'm5-p', 'read', 'second tool output')],
      }),
    ];

    const changed = await store.transformMessages(messages);

    assert.equal(changed, true);
    assert.match(messages[0].parts[0].text, /Archived by opencode-lcm/);
    assert.match(messages[1].parts[0].text, /Archived by opencode-lcm/);
    assert.equal(messages[2].parts[0].metadata.opencodeLcm, 'archive-summary');
    assert.match(messages[2].parts[0].text, /Archived roots:/);
    assert.equal(messages[3].parts[0].type, 'tool');
    assert.equal(messages[3].parts[0].tool, 'lcm_grep');
    assert.equal(messages[3].parts[0].state.output, 'first tool output');
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('buildCompactionContext keeps the latest user outside the archived summary graph', async () => {
  const workspace = makeWorkspace('lcm-compaction-latest-user');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({
        freshTailMessages: 2,
        minMessagesForTransform: 5,
        automaticRetrieval: { enabled: false },
      }),
    );
    await store.init();
    await createSession(store, workspace, 's1', 1);

    for (const [messageID, created, role, part] of [
      ['m1', 1, 'user', textPart('s1', 'm1', 'm1-p', 'older archived message')],
      ['m2', 2, 'assistant', textPart('s1', 'm2', 'm2-p', 'older assistant note')],
      ['m3', 3, 'user', textPart('s1', 'm3', 'm3-p', 'current user request')],
      [
        'm4',
        4,
        'assistant',
        toolCompletedPart('s1', 'm4', 'm4-p', 'lcm_grep', 'first tool output'),
      ],
      ['m5', 5, 'assistant', toolCompletedPart('s1', 'm5', 'm5-p', 'read', 'second tool output')],
    ]) {
      await captureMessage(store, { sessionID: 's1', messageID, created, role, parts: [part] });
    }

    await store.buildCompactionContext('s1');

    const rootList = await store.expand({ sessionID: 's1' });
    const nodeID = firstNodeID(rootList);
    const expanded = await store.expand({ nodeID, includeRaw: true });

    assert.ok(nodeID);
    assert.match(expanded, /older archived message/);
    assert.match(expanded, /older assistant note/);
    assert.ok(!expanded.includes('current user request'));
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('summary rebuilds when archived content changes and expand can target raw matches', async () => {
  const workspace = makeWorkspace('lcm-summary-rebuild');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }),
    );
    await store.init();

    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [textPart('s1', 'm1', 'm1-p', 'alpha archived goal')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm2',
      created: 3,
      parts: [toolCompletedPart('s1', 'm2', 'm2-p', 'ctx_search', 'infra trace')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm3',
      created: 4,
      parts: [textPart('s1', 'm3', 'm3-p', 'gamma archived note')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm4',
      created: 5,
      parts: [textPart('s1', 'm4', 'm4-p', 'fresh tail request')],
    });

    const firstNote = await store.buildCompactionContext('s1');
    const before = await store.expand({ sessionID: 's1' });

    assert.match(firstNote, /LCM prototype resume note/);
    assert.match(before, /alpha archived goal/);
    assert.ok(!before.includes('ctx_search'));

    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 's1',
        time: 2,
        part: textPart('s1', 'm1', 'm1-p', 'omega revised goal'),
      },
    });

    const secondNote = await store.buildCompactionContext('s1');
    const resumed = await store.resume('s1');
    const after = await store.expand({ sessionID: 's1' });
    const nodeID = firstNodeID(after);

    assert.match(secondNote, /omega revised goal/);
    assert.match(resumed, /omega revised goal/);
    assert.match(after, /omega revised goal/);
    assert.ok(!after.includes('alpha archived goal'));
    assert.ok(nodeID);

    const targeted = await store.expand({ nodeID, query: 'omega revised', includeRaw: true });
    assert.match(targeted, /Raw messages:/);
    assert.match(targeted, /m1/);
    assert.match(targeted, /omega revised goal/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('summary node IDs remain expandable after the archive grows and roots change', async () => {
  const workspace = makeWorkspace('lcm-summary-stable-node-id');
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
    await createSession(store, workspace, 's1', 1);

    for (const [messageID, created, role, text] of [
      ['m1', 2, 'user', 'archived note one'],
      ['m2', 3, 'assistant', 'archived note two'],
      ['m3', 4, 'user', 'archived note three'],
      ['m4', 5, 'assistant', 'archived note four'],
      ['m5', 6, 'user', 'archived note five'],
      ['m6', 7, 'assistant', 'archived note six'],
      ['m7', 8, 'user', 'fresh tail request'],
    ]) {
      await captureMessage(store, {
        sessionID: 's1',
        messageID,
        created,
        role,
        parts: [textPart('s1', messageID, `${messageID}-p`, text)],
      });
    }

    const initialResume = await store.buildCompactionContext('s1');
    const stableNodeID = firstNodeID(initialResume);

    assert.ok(stableNodeID);
    assert.match(stableNodeID, /^sum_[a-f0-9]{12}_l0_p0$/);

    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm8',
      created: 9,
      role: 'assistant',
      parts: [textPart('s1', 'm8', 'm8-p', 'newest tail response')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm9',
      created: 10,
      role: 'user',
      parts: [textPart('s1', 'm9', 'm9-p', 'follow-up user request')],
    });

    const rootsAfterGrowth = await store.expand({ sessionID: 's1' });
    const expandedOldNode = await store.expand({ nodeID: stableNodeID, includeRaw: true });

    assert.match(rootsAfterGrowth, /sum_[a-f0-9]{12}_l1_p0/);
    assert.doesNotMatch(expandedOldNode, /Unknown summary node/);
    assert.match(expandedOldNode, /Node: sum_[a-f0-9]{12}_l0_p0/);
    assert.match(expandedOldNode, /archived note one/);
    assert.match(expandedOldNode, /archived note six/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('resume refreshes managed notes instead of reusing stale stored node IDs', async () => {
  const workspace = makeWorkspace('lcm-resume-refresh-managed');
  let store;
  let db;

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
    await createSession(store, workspace, 's1', 1);

    for (const [messageID, created, text] of [
      ['m1', 2, 'resume archived one'],
      ['m2', 3, 'resume archived two'],
      ['m3', 4, 'resume archived three'],
      ['m4', 5, 'resume fresh tail'],
    ]) {
      await captureMessage(store, {
        sessionID: 's1',
        messageID,
        created,
        parts: [textPart('s1', messageID, `${messageID}-p`, text)],
      });
    }

    await store.buildCompactionContext('s1');

    db = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    db.prepare('UPDATE resumes SET note = ? WHERE session_id = ?').run(
      [
        'LCM prototype resume note',
        'Session: s1',
        'Summary roots:',
        '- sum_deadbeefcafe_l9_p9: stale managed resume id',
      ].join('\n'),
      's1',
    );
    db.close();
    db = undefined;

    const refreshed = await store.resume('s1');

    assert.doesNotMatch(refreshed, /sum_deadbeefcafe_l9_p9/);
    assert.match(refreshed, /sum_[a-f0-9]{12}_l0_p0/);
    assert.match(refreshed, /resume archived one/);
  } finally {
    db?.close();
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('stale cached summary nodes are detected and rebuilt before reuse', async () => {
  const workspace = makeWorkspace('lcm-summary-stale-cache');
  let store;
  let driftDb;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }),
    );
    await store.init();

    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [textPart('s1', 'm1', 'm1-p', 'alpha archived goal')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm2',
      created: 3,
      parts: [textPart('s1', 'm2', 'm2-p', 'beta archived note')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm3',
      created: 4,
      parts: [textPart('s1', 'm3', 'm3-p', 'gamma archived detail')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm4',
      created: 5,
      parts: [textPart('s1', 'm4', 'm4-p', 'fresh tail request')],
    });

    const initial = await store.buildCompactionContext('s1');
    assert.match(initial, /alpha archived goal/);

    driftDb = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), {
      enableForeignKeyConstraints: false,
      timeout: 5000,
    });
    driftDb.exec(
      "UPDATE summary_nodes SET summary_text = 'stale cached summary' WHERE session_id = 's1'",
    );
    driftDb.close();
    driftDb = undefined;

    const dryRun = await store.doctor({ sessionID: 's1' });
    const rebuilt = await store.buildCompactionContext('s1');
    const expanded = await store.expand({ sessionID: 's1' });

    assert.match(dryRun, /invalid-summary-graph/);
    assert.match(rebuilt, /alpha archived goal/);
    assert.ok(!rebuilt.includes('stale cached summary'));
    assert.match(expanded, /alpha archived goal/);
    assert.ok(!expanded.includes('stale cached summary'));
  } finally {
    driftDb?.close();
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('session reparenting refreshes descendant managed resume notes', async () => {
  const workspace = makeWorkspace('lcm-lineage-reparent');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, minMessagesForTransform: 4 }),
    );
    await store.init();

    await createSession(store, workspace, 'root-a', 1);
    await createSession(store, workspace, 'root-b', 2);
    await createSession(store, workspace, 'branch', 3, 'root-a');
    await createSession(store, workspace, 'leaf', 4, 'branch');
    await captureMessage(store, {
      sessionID: 'leaf',
      messageID: 'm1',
      created: 5,
      parts: [textPart('leaf', 'm1', 'm1-p', 'leaf session archived note')],
    });

    const before = await store.buildCompactionContext('leaf');

    assert.match(before, /Root session: root-a/);
    assert.match(before, /Parent session: branch/);
    assert.match(before, /Lineage depth: 2/);

    await store.capture({
      type: 'session.updated',
      properties: {
        sessionID: 'branch',
        info: sessionInfo(workspace, 'branch', 10, 'root-b'),
      },
    });

    const resumed = await store.resume('leaf');
    const lineage = await store.lineage('leaf');

    assert.match(resumed, /Root session: root-b/);
    assert.match(resumed, /Parent session: branch/);
    assert.match(resumed, /Lineage depth: 2/);
    assert.match(lineage, /Root session: root-b/);
    assert.match(lineage, /Parent session: branch/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('session updates refuse parent cycles and keep lineage stable', async () => {
  const workspace = makeWorkspace('lcm-lineage-cycle');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    await store.init();

    await createSession(store, workspace, 'root', 1);
    await createSession(store, workspace, 'branch', 2, 'root');
    await createSession(store, workspace, 'leaf', 3, 'branch');

    await store.capture({
      type: 'session.updated',
      properties: {
        sessionID: 'root',
        info: sessionInfo(workspace, 'root', 4, 'leaf'),
      },
    });

    const rootLineage = await store.lineage('root');
    const branchLineage = await store.lineage('branch');
    const leafLineage = await store.lineage('leaf');

    assert.match(rootLineage, /Parent session: none/);
    assert.match(rootLineage, /Root session: root/);
    assert.match(branchLineage, /Parent session: root/);
    assert.match(branchLineage, /Root session: root/);
    assert.match(branchLineage, /Lineage depth: 1/);
    assert.match(leafLineage, /Parent session: branch/);
    assert.match(leafLineage, /Root session: root/);
    assert.match(leafLineage, /Lineage depth: 2/);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

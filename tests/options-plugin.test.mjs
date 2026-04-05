import assert from 'node:assert/strict';
import test from 'node:test';

import OpencodeLcmPlugin from '../dist/index.js';
import { DEFAULT_OPTIONS, resolveOptions } from '../dist/options.js';

import {
  captureMessage,
  conversationMessage,
  makeOptions,
  makeMockClient,
  makePluginContext,
  makeToolContext,
  makeWorkspace,
  sessionInfo,
  textPart,
  toolCompletedPart,
  writeFixtureFile,
} from './helpers.mjs';

test('resolveOptions normalizes malformed plugin config', () => {
  const resolved = resolveOptions({
    interop: {
      contextMode: false,
      ignoreToolPrefixes: ['custom_', '', 42],
    },
    scopeDefaults: {
      grep: 'bogus',
      describe: 'all',
    },
    scopeProfiles: [
      null,
      {},
      { worktree: '' },
      { worktree: 'C:/repo/a', grep: 'all', describe: 'invalid' },
    ],
    retention: {
      staleSessionDays: -1,
      deletedSessionDays: -4,
      orphanBlobDays: 7,
    },
    privacy: {
      excludeToolPrefixes: ['secret_', '', 42],
      excludePathPatterns: ['fixtures[/\\\\]private', null, ''],
      redactPatterns: ['token_[0-9]+', false, ''],
    },
    automaticRetrieval: {
      enabled: false,
      maxChars: Number.NaN,
      minTokens: Number.NaN,
      maxMessageHits: 3,
      maxSummaryHits: Number.NaN,
      maxArtifactHits: 2,
      scopeOrder: ['worktree', 'bogus', 'session', 'worktree'],
      scopeBudgets: { session: -1, root: 4, worktree: 0, all: Number.NaN },
      stop: { targetHits: -1, stopOnFirstScopeWithHits: true },
    },
    compactContextLimit: Number.NaN,
    deferredPartUpdateDelayMs: Number.NaN,
    previewBytePeek: Number.NaN,
    systemHint: false,
    binaryPreviewProviders: [],
  });

  assert.equal(resolved.interop.contextMode, false);
  assert.deepEqual(resolved.interop.ignoreToolPrefixes, ['custom_']);
  assert.deepEqual(resolved.scopeDefaults, { grep: 'session', describe: 'all' });
  assert.deepEqual(resolved.scopeProfiles, [
    { worktree: 'C:/repo/a', grep: 'all', describe: 'session' },
  ]);
  assert.equal(resolved.retention.staleSessionDays, undefined);
  assert.equal(resolved.retention.deletedSessionDays, undefined);
  assert.equal(resolved.retention.orphanBlobDays, 7);
  assert.deepEqual(resolved.privacy, {
    excludeToolPrefixes: ['secret_'],
    excludePathPatterns: ['fixtures[/\\\\]private'],
    redactPatterns: ['token_[0-9]+'],
  });
  assert.equal(resolved.automaticRetrieval.enabled, false);
  assert.equal(resolved.automaticRetrieval.maxChars, DEFAULT_OPTIONS.automaticRetrieval.maxChars);
  assert.equal(resolved.automaticRetrieval.minTokens, DEFAULT_OPTIONS.automaticRetrieval.minTokens);
  assert.equal(resolved.automaticRetrieval.maxMessageHits, 3);
  assert.equal(
    resolved.automaticRetrieval.maxSummaryHits,
    DEFAULT_OPTIONS.automaticRetrieval.maxSummaryHits,
  );
  assert.equal(resolved.automaticRetrieval.maxArtifactHits, 2);
  assert.deepEqual(resolved.automaticRetrieval.scopeOrder, ['worktree', 'session']);
  assert.deepEqual(resolved.automaticRetrieval.scopeBudgets, {
    session: DEFAULT_OPTIONS.automaticRetrieval.scopeBudgets.session,
    root: 4,
    worktree: 0,
    all: DEFAULT_OPTIONS.automaticRetrieval.scopeBudgets.all,
  });
  assert.deepEqual(resolved.automaticRetrieval.stop, {
    targetHits: DEFAULT_OPTIONS.automaticRetrieval.stop.targetHits,
    stopOnFirstScopeWithHits: true,
  });
  assert.equal(resolved.compactContextLimit, DEFAULT_OPTIONS.compactContextLimit);
  assert.equal(resolved.deferredPartUpdateDelayMs, DEFAULT_OPTIONS.deferredPartUpdateDelayMs);
  assert.equal(resolved.previewBytePeek, DEFAULT_OPTIONS.previewBytePeek);
  assert.equal(resolved.systemHint, false);
  assert.deepEqual(resolved.binaryPreviewProviders, DEFAULT_OPTIONS.binaryPreviewProviders);
});

test('plugin exposes tools, records events, and appends compaction context once', async () => {
  const workspace = makeWorkspace('lcm-plugin');

  try {
    const hooks = await OpencodeLcmPlugin(
      makePluginContext(workspace),
      makeOptions({ freshTailMessages: 1 }),
    );
    const toolKeys = Object.keys(hooks.tool ?? {}).sort();

    assert.deepEqual(
      toolKeys,
      [
        'lcm_artifact',
        'lcm_agentic_map',
        'lcm_blob_gc',
        'lcm_blob_stats',
        'lcm_describe',
        'lcm_doctor',
        'lcm_expand',
        'lcm_export_snapshot',
        'lcm_grep',
        'lcm_import_snapshot',
        'lcm_lineage',
        'lcm_pin_session',
        'lcm_retention_report',
        'lcm_retention_prune',
        'lcm_resume',
        'lcm_status',
        'lcm_task',
        'lcm_tasks',
        'lcm_unpin_session',
      ].sort(),
    );

    await hooks.event({
      event: {
        type: 'session.created',
        properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
      },
    });
    await captureMessage(
      { capture: (event) => hooks.event({ event }) },
      {
        sessionID: 's1',
        messageID: 'm1',
        created: 2,
        parts: [textPart('s1', 'm1', 'm1-p', 'plugin hook body')],
      },
    );

    const toolContext = makeToolContext(workspace, 's1');
    const status = await hooks.tool.lcm_status.execute({}, toolContext);
    const describe = await hooks.tool.lcm_describe.execute({ sessionID: 's1' }, toolContext);
    const doctor = await hooks.tool.lcm_doctor.execute({ sessionID: 's1' }, toolContext);

    assert.match(status, /schema_version=1/);
    assert.match(status, /session_count=1/);
    assert.match(status, /automatic_retrieval_scope_order=session,root,worktree/);
    assert.match(status, /automatic_retrieval_scope_budgets=session:16,root:12,worktree:8,all:6/);
    assert.match(status, /automatic_retrieval_stop_target_hits=3/);
    assert.match(status, /automatic_retrieval_stop_on_first_scope_with_hits=false/);
    assert.match(status, /deferred_part_update_delay_ms=250/);
    assert.match(describe, /Session: s1/);
    assert.match(describe, /plugin hook body/);
    assert.match(doctor, /checked_scope=session:s1/);

    const firstCompaction = { context: [], prompt: 'keep-default' };
    await hooks['experimental.session.compacting']({ sessionID: 's1' }, firstCompaction);
    assert.equal(firstCompaction.prompt, 'keep-default');
    assert.equal(firstCompaction.context.length, 1);
    assert.match(firstCompaction.context[0], /LCM prototype resume note/);

    const dedupedCompaction = { context: [firstCompaction.context[0]], prompt: 'keep-default' };
    await hooks['experimental.session.compacting']({ sessionID: 's1' }, dedupedCompaction);
    assert.equal(dedupedCompaction.prompt, 'keep-default');
    assert.equal(dedupedCompaction.context.length, 1);
  } finally {
    // Plugin hooks keep their SQLite store open for the life of the plugin instance.
    // Let the temp workspace be reclaimed by the OS after process exit.
  }
});

test('plugin lcm_task and lcm_tasks map delegation to host child sessions', async () => {
  const workspace = makeWorkspace('lcm-plugin-task-tools');

  try {
    const client = makeMockClient();
    const hooks = await OpencodeLcmPlugin(
      {
        ...makePluginContext(workspace),
        client,
      },
      makeOptions(),
    );

    const toolContext = makeToolContext(workspace, 'parent-1');
    const single = await hooks.tool.lcm_task.execute(
      {
        title: 'Investigate retrieval drift',
        prompt: 'Find why retrieval drifted after compaction.',
        agent: 'explore',
      },
      toolContext,
    );
    const batch = await hooks.tool.lcm_tasks.execute(
      {
        tasks: [
          {
            title: 'Audit summaries',
            prompt: 'Check summary graph integrity.',
            agent: 'explore',
          },
          {
            title: 'Review retention',
            prompt: 'Review retention pruning edge cases.',
          },
        ],
      },
      toolContext,
    );

    assert.match(single, /status=queued/);
    assert.match(single, /session_id=child-1/);
    assert.match(single, /parent_session_id=parent-1/);
    assert.match(batch, /spawned=2/);
    assert.match(batch, /session_id=child-2 title=Audit summaries agent=explore/);
    assert.match(batch, /session_id=child-3 title=Review retention agent=default/);

    assert.equal(client.calls.length, 6);
    assert.deepEqual(client.calls[0], {
      type: 'create',
      input: {
        body: { parentID: 'parent-1', title: 'Investigate retrieval drift' },
        query: { directory: workspace },
        responseStyle: 'data',
      },
    });
    assert.deepEqual(client.calls[1], {
      type: 'promptAsync',
      input: {
        path: { id: 'child-1' },
        query: { directory: workspace },
        body: {
          agent: 'explore',
          model: undefined,
          parts: [{ type: 'text', text: 'Find why retrieval drifted after compaction.' }],
        },
        responseStyle: 'data',
      },
    });
    assert.deepEqual(client.calls[2], {
      type: 'create',
      input: {
        body: { parentID: 'parent-1', title: 'Audit summaries' },
        query: { directory: workspace },
        responseStyle: 'data',
      },
    });
    assert.deepEqual(client.calls[3], {
      type: 'create',
      input: {
        body: { parentID: 'parent-1', title: 'Review retention' },
        query: { directory: workspace },
        responseStyle: 'data',
      },
    });
    assert.deepEqual(client.calls[4], {
      type: 'promptAsync',
      input: {
        path: { id: 'child-2' },
        query: { directory: workspace },
        body: {
          agent: 'explore',
          model: undefined,
          parts: [{ type: 'text', text: 'Check summary graph integrity.' }],
        },
        responseStyle: 'data',
      },
    });
    assert.deepEqual(client.calls[5], {
      type: 'promptAsync',
      input: {
        path: { id: 'child-3' },
        query: { directory: workspace },
        body: {
          agent: undefined,
          model: undefined,
          parts: [{ type: 'text', text: 'Review retention pruning edge cases.' }],
        },
        responseStyle: 'data',
      },
    });
  } finally {
    // Plugin hooks keep their SQLite store open for the life of the plugin instance.
    // Let the temp workspace be reclaimed by the OS after process exit.
  }
});

test('plugin lcm_agentic_map fans out JSONL items into delegated child sessions', async () => {
  const workspace = makeWorkspace('lcm-plugin-agentic-map');

  try {
    const client = makeMockClient();
    const inputPath = writeFixtureFile(
      workspace,
      'fixtures/items.jsonl',
      '{"id":1,"topic":"summaries"}\n{"id":2,"topic":"retention"}\n',
    );
    const hooks = await OpencodeLcmPlugin(
      {
        ...makePluginContext(workspace),
        client,
      },
      makeOptions(),
    );

    const out = await hooks.tool.lcm_agentic_map.execute(
      {
        inputPath,
        promptTemplate: 'Investigate this item:\n{{item}}',
        titlePrefix: 'Batch audit',
        agent: 'explore',
      },
      makeToolContext(workspace, 'parent-map'),
    );

    assert.match(out, /status=queued/);
    assert.match(out, /input_items=2/);
    assert.match(out, /spawned=2/);
    assert.match(out, /1\. session_id=child-1 title=Batch audit 1/);
    assert.match(out, /2\. session_id=child-2 title=Batch audit 2/);

    assert.equal(client.calls.length, 4);
    assert.deepEqual(client.calls[0], {
      type: 'create',
      input: {
        body: { parentID: 'parent-map', title: 'Batch audit 1' },
        query: { directory: workspace },
        responseStyle: 'data',
      },
    });
    assert.deepEqual(client.calls[1], {
      type: 'create',
      input: {
        body: { parentID: 'parent-map', title: 'Batch audit 2' },
        query: { directory: workspace },
        responseStyle: 'data',
      },
    });
    assert.deepEqual(client.calls[2], {
      type: 'promptAsync',
      input: {
        path: { id: 'child-1' },
        query: { directory: workspace },
        body: {
          agent: 'explore',
          model: undefined,
          parts: [
            {
              type: 'text',
              text: 'Investigate this item:\n{\n  "id": 1,\n  "topic": "summaries"\n}',
            },
          ],
        },
        responseStyle: 'data',
      },
    });
    assert.deepEqual(client.calls[3], {
      type: 'promptAsync',
      input: {
        path: { id: 'child-2' },
        query: { directory: workspace },
        body: {
          agent: 'explore',
          model: undefined,
          parts: [
            {
              type: 'text',
              text: 'Investigate this item:\n{\n  "id": 2,\n  "topic": "retention"\n}',
            },
          ],
        },
        responseStyle: 'data',
      },
    });
  } finally {
    // Plugin hooks keep their SQLite store open for the life of the plugin instance.
    // Let the temp workspace be reclaimed by the OS after process exit.
  }
});

test('plugin system and message transform hooks respect options', async () => {
  const workspace = makeWorkspace('lcm-plugin-transform');

  try {
    const hooks = await OpencodeLcmPlugin(
      makePluginContext(workspace),
      makeOptions({ systemHint: false, freshTailMessages: 1, minMessagesForTransform: 3 }),
    );

    await hooks.event({
      event: {
        type: 'session.created',
        properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
      },
    });

    const systemOutput = { system: [] };
    await hooks['experimental.chat.system.transform']({ sessionID: 's1', model: {} }, systemOutput);
    assert.deepEqual(systemOutput.system, []);

    const output = {
      messages: [
        conversationMessage({
          sessionID: 's1',
          messageID: 'm1',
          created: 1,
          parts: [textPart('s1', 'm1', 'm1-p', 'first archived message')],
        }),
        conversationMessage({
          sessionID: 's1',
          messageID: 'm2',
          created: 2,
          parts: [toolCompletedPart('s1', 'm2', 'm2-p', 'ctx_search', 'infrastructure output')],
        }),
        conversationMessage({
          sessionID: 's1',
          messageID: 'm3',
          created: 3,
          parts: [textPart('s1', 'm3', 'm3-p', 'fresh user request')],
        }),
      ],
    };

    await hooks['experimental.chat.messages.transform']({}, output);

    assert.match(output.messages[0].parts[0].text, /Archived by opencode-lcm/);
    assert.match(output.messages[1].parts[0].state.output, /infrastructure tool output omitted/);
    const summaryPart = output.messages[2].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'archive-summary',
    );
    assert.equal(output.messages[2].parts[0].text, 'fresh user request');
    assert.ok(summaryPart);
    assert.match(summaryPart.text, /Summary roots:/);
    assert.ok(!summaryPart.text.includes('ctx_search'));
  } finally {
    // Plugin hooks keep their SQLite store open for the life of the plugin instance.
    // Let the temp workspace be reclaimed by the OS after process exit.
  }
});

test('plugin ignores malformed message.part.updated events instead of crashing', async () => {
  const workspace = makeWorkspace('lcm-plugin-malformed-event');

  try {
    const hooks = await OpencodeLcmPlugin(makePluginContext(workspace), makeOptions());

    await hooks.event({
      event: {
        type: 'session.created',
        properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
      },
    });

    await assert.doesNotReject(async () => {
      await hooks.event({
        event: {
          type: 'message.part.updated',
          properties: {},
        },
      });
    });

    const toolContext = makeToolContext(workspace, 's1');
    const status = await hooks.tool.lcm_status.execute({}, toolContext);
    assert.match(status, /session_count=1/);
    assert.doesNotMatch(status, /message\.part\.updated=1/);
  } finally {
    // Plugin hooks keep their SQLite store open for the life of the plugin instance.
    // Let the temp workspace be reclaimed by the OS after process exit.
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import OpencodeLcmPlugin from '../dist/index.js';
import { DEFAULT_OPTIONS, resolveOptions } from '../dist/options.js';

import {
  captureMessage,
  conversationMessage,
  makeOptions,
  makePluginContext,
  makeToolContext,
  makeWorkspace,
  sessionInfo,
  textPart,
  toolCompletedPart,
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
    assert.equal(output.messages[2].parts[0].metadata.opencodeLcm, 'archive-summary');
    assert.match(output.messages[2].parts[0].text, /Archived roots:/);
    assert.ok(!output.messages[2].parts[0].text.includes('ctx_search'));
  } finally {
    // Plugin hooks keep their SQLite store open for the life of the plugin instance.
    // Let the temp workspace be reclaimed by the OS after process exit.
  }
});

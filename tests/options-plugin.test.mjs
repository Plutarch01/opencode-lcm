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

const ALLOW_UNSAFE_BUN_WINDOWS_ENV = 'OPENCODE_LCM_ALLOW_UNSAFE_BUN_WINDOWS';

async function withSimulatedBunWindows(run) {
  const hadBun = 'Bun' in globalThis;
  const previousBun = globalThis.Bun;
  const previousAllowUnsafe = process.env[ALLOW_UNSAFE_BUN_WINDOWS_ENV];
  const previousSqliteRuntime = process.env.OPENCODE_LCM_SQLITE_RUNTIME;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  try {
    globalThis.Bun = { version: '1.3.11' };
    delete process.env[ALLOW_UNSAFE_BUN_WINDOWS_ENV];
    delete process.env.OPENCODE_LCM_SQLITE_RUNTIME;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      enumerable: true,
      value: 'win32',
    });
    await run();
  } finally {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
    if (previousAllowUnsafe === undefined) delete process.env[ALLOW_UNSAFE_BUN_WINDOWS_ENV];
    else process.env[ALLOW_UNSAFE_BUN_WINDOWS_ENV] = previousAllowUnsafe;
    if (previousSqliteRuntime === undefined) delete process.env.OPENCODE_LCM_SQLITE_RUNTIME;
    else process.env.OPENCODE_LCM_SQLITE_RUNTIME = previousSqliteRuntime;
    if (hadBun) globalThis.Bun = previousBun;
    else delete globalThis.Bun;
  }
}

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
    previewBytePeek: Number.NaN,
    systemHint: false,
    binaryPreviewProviders: [],
    summaryV2: {
      strategy: 'bogus',
      perMessageBudget: 90,
    },
    runtimeSafety: {
      allowUnsafeBunWindows: 'yes',
    },
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
  assert.equal(resolved.previewBytePeek, DEFAULT_OPTIONS.previewBytePeek);
  assert.equal(resolved.systemHint, false);
  assert.deepEqual(resolved.binaryPreviewProviders, DEFAULT_OPTIONS.binaryPreviewProviders);
  assert.deepEqual(resolved.summaryV2, {
    strategy: DEFAULT_OPTIONS.summaryV2.strategy,
    perMessageBudget: 90,
  });
  assert.deepEqual(resolved.runtimeSafety, {
    allowUnsafeBunWindows: false,
  });
});

test('plugin defaults to Bun on Windows safe mode before opening SQLite', async () => {
  const workspace = makeWorkspace('lcm-plugin-bun-win-safe-mode');

  try {
    await withSimulatedBunWindows(async () => {
      const hooks = await OpencodeLcmPlugin(makePluginContext(workspace), makeOptions());

      assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), ['lcm_status']);
      assert.equal(hooks.tool.lcm_describe, undefined);

      await hooks.event({
        event: {
          type: 'session.created',
          properties: { sessionID: 's1', info: sessionInfo(workspace, 's1', 1) },
        },
      });

      const systemOutput = { system: [] };
      await hooks['experimental.chat.system.transform'](
        { sessionID: 's1', model: {} },
        systemOutput,
      );
      assert.deepEqual(systemOutput.system, []);

      const messagesOutput = {
        messages: [
          conversationMessage({
            sessionID: 's1',
            messageID: 'm1',
            created: 1,
            parts: [textPart('s1', 'm1', 'm1-p1', 'safe mode leaves messages untouched')],
          }),
        ],
      };
      await hooks['experimental.chat.messages.transform']({}, messagesOutput);
      assert.equal(messagesOutput.messages[0].parts[0].text, 'safe mode leaves messages untouched');

      const compactionOutput = { context: [], prompt: 'keep-default' };
      await hooks['experimental.session.compacting']({ sessionID: 's1' }, compactionOutput);
      assert.deepEqual(compactionOutput, { context: [], prompt: 'keep-default' });

      const status = await hooks.tool.lcm_status.execute({}, makeToolContext(workspace, 's1'));
      assert.match(status, /status=disabled/);
      assert.match(status, /reason=bun_windows_runtime_guard/);
      assert.match(status, /available_tools=lcm_status/);
      assert.match(status, /runtime_safety_allow_unsafe_bun_windows=false/);
      assert.match(status, /override_config=runtimeSafety\.allowUnsafeBunWindows=true/);
      assert.match(status, /override_env=OPENCODE_LCM_ALLOW_UNSAFE_BUN_WINDOWS=1/);
    });
  } finally {
    // Safe mode does not open a store handle.
  }
});

test('plugin allows explicit Bun on Windows override', async () => {
  const workspace = makeWorkspace('lcm-plugin-bun-win-override');

  try {
    await withSimulatedBunWindows(async () => {
      const hooks = await OpencodeLcmPlugin(
        makePluginContext(workspace),
        makeOptions({ runtimeSafety: { allowUnsafeBunWindows: true }, freshTailMessages: 1 }),
      );

      assert.ok(hooks.tool.lcm_describe);

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
          parts: [textPart('s1', 'm1', 'm1-p', 'override-enabled body')],
        },
      );

      const toolContext = makeToolContext(workspace, 's1');
      const status = await hooks.tool.lcm_status.execute({}, toolContext);
      const describe = await hooks.tool.lcm_describe.execute({ sessionID: 's1' }, toolContext);

      assert.match(status, /schema_version=2/);
      assert.match(status, /runtime_safety_allow_unsafe_bun_windows=true/);
      assert.match(describe, /override-enabled body/);
    });
  } finally {
    // Plugin hooks keep their SQLite store open for the life of the plugin instance.
    // Let the temp workspace be reclaimed by the OS after process exit.
  }
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
        'lcm_retrieval_debug',
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
    const retrieval = await hooks.tool.lcm_retrieval_debug.execute({}, toolContext);
    const describe = await hooks.tool.lcm_describe.execute({ sessionID: 's1' }, toolContext);
    const doctor = await hooks.tool.lcm_doctor.execute({ sessionID: 's1' }, toolContext);

    assert.match(status, /schema_version=2/);
    assert.match(status, /session_count=1/);
    assert.match(status, /db_bytes=\d+/);
    assert.match(status, /prunable_events=0/);
    assert.match(status, /message_fts=1/);
    assert.match(status, /automatic_retrieval_scope_order=session,root,worktree/);
    assert.match(status, /automatic_retrieval_scope_budgets=session:16,root:12,worktree:8,all:6/);
    assert.match(status, /automatic_retrieval_stop_target_hits=3/);
    assert.match(status, /automatic_retrieval_stop_on_first_scope_with_hits=false/);
    assert.match(retrieval, /status=no-debug-data/);
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
    const retrieval = await hooks.tool.lcm_retrieval_debug.execute(
      {},
      makeToolContext(workspace, 's1'),
    );

    assert.match(output.messages[0].parts[0].text, /Archived by opencode-lcm/);
    assert.match(output.messages[1].parts[0].state.output, /infrastructure tool output omitted/);
    const summaryPart = output.messages[2].parts.find(
      (part) => part.type === 'text' && part.metadata?.opencodeLcm === 'archive-summary',
    );
    assert.equal(output.messages[2].parts[0].text, 'fresh user request');
    assert.ok(summaryPart);
    assert.match(summaryPart.text, /Summary roots:/);
    assert.ok(!summaryPart.text.includes('ctx_search'));
    assert.match(retrieval, /status=no-hits/);
    assert.match(retrieval, /stop_reason=scope-order-exhausted/);
  } finally {
    // Plugin hooks keep their SQLite store open for the life of the plugin instance.
    // Let the temp workspace be reclaimed by the OS after process exit.
  }
});

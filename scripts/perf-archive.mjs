import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  captureMessage,
  cleanupWorkspace,
  conversationMessage,
  createSession,
  makeOptions,
  makeWorkspace,
  reasoningPart,
  sessionInfo,
  textPart,
  toolCompletedPart,
} from '../tests/helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distStorePath = path.join(repoRoot, 'dist', 'store.js');
const distLoggingPath = path.join(repoRoot, 'dist', 'logging.js');

if (!existsSync(distStorePath)) {
  console.error(`Missing build output at ${distStorePath}. Run npm run build first.`);
  process.exit(1);
}

const { SqliteLcmStore } = await import(pathToFileURL(distStorePath).href);
const { setLogger } = await import(pathToFileURL(distLoggingPath).href);

setLogger({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

const DEFAULTS = {
  mediumMessages: 150,
  largeMessages: 900,
  samples: 2,
  warmRuns: 5,
  jsonOut: undefined,
  keepWorkspaces: false,
};

const SIGNALS = {
  branch: 'branch_focus_invoice_42 approval_chain',
  root: 'root_runbook_ledger_7 tenant_map',
  worktree: 'worktree_cache_replay_19 shard_drift',
};

function parseInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--medium-messages':
        options.mediumMessages = parseInteger(next, '--medium-messages');
        index++;
        break;
      case '--large-messages':
        options.largeMessages = parseInteger(next, '--large-messages');
        index++;
        break;
      case '--samples':
        options.samples = parseInteger(next, '--samples');
        index++;
        break;
      case '--warm-runs':
        options.warmRuns = parseInteger(next, '--warm-runs');
        index++;
        break;
      case '--json-out':
        options.jsonOut = next;
        index++;
        break;
      case '--keep-workspaces':
        options.keepWorkspaces = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function round(value) {
  return Number(value.toFixed(2));
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    minMs: round(sorted[0]),
    medianMs: round(median),
    meanMs: round(mean),
    maxMs: round(sorted.at(-1)),
  };
}

async function measureAsync(action) {
  const started = performance.now();
  const result = await action();
  return {
    result,
    durationMs: round(performance.now() - started),
  };
}

async function measureWarmMedian(runs, action) {
  const durations = [];
  let lastResult;
  for (let index = 0; index < runs; index++) {
    const { result, durationMs } = await measureAsync(action);
    lastResult = result;
    durations.push(durationMs);
  }
  return { lastResult, medianMs: summarize(durations).medianMs, durations };
}

function buildBody(kind, messageIndex, emphasis, long = false) {
  const repeated =
    'billing incident review cache invalidation shard routing tenant lookup invoice retry trace evidence ';
  return [
    `${kind} note ${messageIndex}.`,
    emphasis ? `${emphasis}.` : '',
    repeated.repeat(long ? 18 : 6),
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function buildParts(sessionID, messageID, kind, messageIndex, emphasis, options = {}) {
  const parts = [];
  parts.push(
    textPart(
      sessionID,
      messageID,
      `${messageID}-text`,
      buildBody(kind, messageIndex, emphasis, options.longText ?? false),
    ),
  );

  if (messageIndex % 5 === 0) {
    parts.push(
      reasoningPart(
        sessionID,
        messageID,
        `${messageID}-reasoning`,
        buildBody(`${kind} reasoning`, messageIndex, emphasis, false),
      ),
    );
  }

  if (messageIndex % 9 === 0) {
    parts.push(
      toolCompletedPart(
        sessionID,
        messageID,
        `${messageID}-tool`,
        'archive_search',
        buildBody(`${kind} tool output`, messageIndex, emphasis, true),
      ),
    );
  }

  return parts;
}

function cloneMessages(messages) {
  return structuredClone(messages);
}

async function seedSession({
  store,
  directory,
  sessionID,
  parentID,
  kind,
  count,
  createdBase,
  emphasis,
  finalPrompt,
}) {
  await createSession(store, directory, sessionID, createdBase, parentID);
  const messages = [];

  for (let index = 1; index <= count; index++) {
    const role = index === count ? 'user' : index % 2 === 0 ? 'assistant' : 'user';
    const messageID = `${sessionID}-m${index}`;
    const created = createdBase + index;
    const messageEmphasis =
      index === count || index >= count - 2
        ? finalPrompt
        : index % 11 === 0
          ? emphasis
          : `${kind} continuity ${index}`;
    const parts = buildParts(sessionID, messageID, kind, index, messageEmphasis, {
      longText: index % 10 === 0,
    });

    await captureMessage(store, { sessionID, messageID, created, role, parts });
    messages.push(conversationMessage({ sessionID, messageID, created, role, parts }));
  }

  return messages;
}

function buildPerfOptions() {
  return makeOptions({
    automaticRetrieval: {
      enabled: true,
      maxChars: 1000,
      minTokens: 2,
      maxMessageHits: 2,
      maxSummaryHits: 1,
      maxArtifactHits: 1,
      scopeOrder: ['session', 'root', 'worktree'],
      scopeBudgets: { session: 32, root: 24, worktree: 16, all: 12 },
      stop: { targetHits: 4, stopOnFirstScopeWithHits: false },
    },
    freshTailMessages: 4,
    minMessagesForTransform: 8,
    summaryCharBudget: 1200,
    partCharBudget: 160,
    largeContentThreshold: 260,
    artifactPreviewChars: 140,
  });
}

async function addDeletedRetentionCandidate(store, workspace) {
  const oldTimestamp = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const info = sessionInfo(workspace, 'deleted-retention-candidate', oldTimestamp, undefined);
  await store.capture({
    type: 'session.created',
    timestamp: oldTimestamp,
    properties: { sessionID: 'deleted-retention-candidate', info },
  });
  await store.capture({
    type: 'session.deleted',
    timestamp: oldTimestamp + 1,
    properties: { sessionID: 'deleted-retention-candidate', info },
  });
}

async function runScenario(name, branchMessageCount, config) {
  const workspace = makeWorkspace(`lcm-perf-${name}`);
  const snapshotPath = path.join(workspace, `${name}-snapshot.json`);
  const importWorkspace = makeWorkspace(`lcm-perf-${name}-import`);
  const options = buildPerfOptions();
  const rootMessageCount = Math.max(20, Math.round(branchMessageCount / 5));
  const peerMessageCount = Math.max(24, Math.round(branchMessageCount / 3));
  let store;
  let importedStore;
  let reopenedStore;

  try {
    store = new SqliteLcmStore(workspace, options);
    await store.init();

    const { durationMs: seedCaptureMs, result: originalBranchMessages } = await measureAsync(
      async () => {
        await seedSession({
          store,
          directory: workspace,
          sessionID: 'root-main',
          kind: 'root',
          count: rootMessageCount,
          createdBase: 1000,
          emphasis: SIGNALS.root,
          finalPrompt: `Keep the root runbook phrase handy: ${SIGNALS.root}`,
        });
        const branchMessages = await seedSession({
          store,
          directory: workspace,
          sessionID: 'branch-main',
          parentID: 'root-main',
          kind: 'branch',
          count: branchMessageCount,
          createdBase: 10_000,
          emphasis: SIGNALS.branch,
          finalPrompt: `Go ahead and continue the approval investigation for ${SIGNALS.branch}`,
        });
        await seedSession({
          store,
          directory: workspace,
          sessionID: 'peer-main',
          kind: 'worktree',
          count: peerMessageCount,
          createdBase: 20_000,
          emphasis: SIGNALS.worktree,
          finalPrompt: `Remember the peer cache replay marker ${SIGNALS.worktree}`,
        });
        return branchMessages;
      },
    );

    const branchSession = await store.describe({ sessionID: 'branch-main' });
    assert.match(branchSession, /Messages:/);

    const transformInput = cloneMessages(originalBranchMessages);
    const { durationMs: transformMs, result: transformChanged } = await measureAsync(() =>
      store.transformMessages(transformInput),
    );
    assert.equal(transformChanged, true);
    const syntheticParts = transformInput.flatMap((message) =>
      message.parts.filter((part) => part.type === 'text' && part.metadata?.opencodeLcm),
    );
    assert.ok(syntheticParts.some((part) => part.metadata?.opencodeLcm === 'archive-summary'));
    const retrievedContextInjected = syntheticParts.some(
      (part) => part.metadata?.opencodeLcm === 'retrieved-context',
    );

    const grepSession = await measureWarmMedian(config.warmRuns, () =>
      store.grep({ query: SIGNALS.branch, sessionID: 'branch-main', scope: 'session', limit: 5 }),
    );
    const grepRoot = await measureWarmMedian(config.warmRuns, () =>
      store.grep({ query: SIGNALS.root, sessionID: 'branch-main', scope: 'root', limit: 5 }),
    );
    const grepWorktree = await measureWarmMedian(config.warmRuns, () =>
      store.grep({
        query: SIGNALS.worktree,
        sessionID: 'branch-main',
        scope: 'worktree',
        limit: 5,
      }),
    );
    assert.ok(grepSession.lastResult.some((result) => result.sessionID === 'branch-main'));
    assert.ok(grepRoot.lastResult.some((result) => result.sessionID === 'root-main'));
    assert.ok(grepWorktree.lastResult.some((result) => result.sessionID === 'peer-main'));

    const resume = await measureWarmMedian(config.warmRuns, () => store.resume('branch-main'));
    assert.ok(resume.lastResult.length > 0);

    const stats = await store.stats();
    assert.ok(stats.summaryNodeCount > 0);
    assert.ok(stats.artifactCount > 0);

    const { durationMs: snapshotExportMs, result: exportText } = await measureAsync(() =>
      store.exportSnapshot({ filePath: snapshotPath, scope: 'worktree', sessionID: 'branch-main' }),
    );
    assert.match(exportText, /sessions=/);

    importedStore = new SqliteLcmStore(importWorkspace, options);
    await importedStore.init();
    const { durationMs: snapshotImportMs, result: importText } = await measureAsync(() =>
      importedStore.importSnapshot({ filePath: snapshotPath, mode: 'replace' }),
    );
    assert.match(importText, /messages=/);
    const importedGrep = await importedStore.grep({
      query: SIGNALS.branch,
      sessionID: 'branch-main',
      scope: 'session',
      limit: 5,
    });
    assert.ok(importedGrep.length > 0);
    importedStore.close();
    importedStore = undefined;

    store.close();
    store = undefined;

    reopenedStore = new SqliteLcmStore(workspace, options);
    const { durationMs: reopenInitMs } = await measureAsync(() => reopenedStore.init());
    const { durationMs: reopenFirstGrepMs, result: reopenGrep } = await measureAsync(() =>
      reopenedStore.grep({
        query: SIGNALS.branch,
        sessionID: 'branch-main',
        scope: 'session',
        limit: 5,
      }),
    );
    const { durationMs: reopenResumeMs, result: reopenResume } = await measureAsync(() =>
      reopenedStore.resume('branch-main'),
    );
    assert.ok(reopenGrep.length > 0);
    assert.ok(reopenResume.length > 0);

    await addDeletedRetentionCandidate(reopenedStore, workspace);
    const { durationMs: retentionPruneMs, result: retentionPrune } = await measureAsync(() =>
      reopenedStore.retentionPrune({
        deletedSessionDays: 0,
        orphanBlobDays: undefined,
        apply: true,
      }),
    );
    assert.match(retentionPrune, /deleted_sessions=1/);

    reopenedStore.close();
    reopenedStore = undefined;

    return {
      scenario: name,
      branchMessageCount,
      rootMessageCount,
      peerMessageCount,
      seedCaptureMs,
      transformMs,
      grepSessionMs: grepSession.medianMs,
      grepRootMs: grepRoot.medianMs,
      grepWorktreeMs: grepWorktree.medianMs,
      resumeMs: resume.medianMs,
      snapshotExportMs,
      snapshotImportMs,
      reopenInitMs,
      reopenFirstGrepMs,
      reopenResumeMs,
      retentionPruneMs,
      retrievedContextInjected,
      summaryNodeCount: stats.summaryNodeCount,
      artifactCount: stats.artifactCount,
      totalEvents: stats.totalEvents,
    };
  } finally {
    reopenedStore?.close();
    importedStore?.close();
    store?.close();
    if (!config.keepWorkspaces) {
      await cleanupWorkspace(workspace);
      await cleanupWorkspace(importWorkspace);
    }
  }
}

function aggregateScenario(samples) {
  const metricNames = [
    'seedCaptureMs',
    'transformMs',
    'grepSessionMs',
    'grepRootMs',
    'grepWorktreeMs',
    'resumeMs',
    'snapshotExportMs',
    'snapshotImportMs',
    'reopenInitMs',
    'reopenFirstGrepMs',
    'reopenResumeMs',
    'retentionPruneMs',
  ];
  return Object.fromEntries(
    metricNames.map((name) => [name, summarize(samples.map((sample) => sample[name]))]),
  );
}

function printScenarioSummary(name, messageCount, summary, lastSample) {
  console.log(`${name} (${messageCount} branch messages, ${lastSample.totalEvents} events):`);
  for (const [metricName, metric] of Object.entries(summary)) {
    console.log(
      `- ${metricName}: median=${metric.medianMs}ms mean=${metric.meanMs}ms min=${metric.minMs}ms max=${metric.maxMs}ms`,
    );
  }
  console.log(
    `- archive_state: summaries=${lastSample.summaryNodeCount} artifacts=${lastSample.artifactCount} retrieved_context=${lastSample.retrievedContextInjected}`,
  );
}

const config = parseArgs(process.argv.slice(2));
const scenarios = [
  ['medium', config.mediumMessages],
  ['large', config.largeMessages],
];
const rawResults = {};

console.log(
  `Archive perf harness: samples=${config.samples} warmRuns=${config.warmRuns} medium=${config.mediumMessages} large=${config.largeMessages}`,
);

for (const [name, count] of scenarios) {
  const samples = [];
  for (let sample = 1; sample <= config.samples; sample++) {
    console.log(`Running ${name} sample ${sample}/${config.samples}...`);
    samples.push(await runScenario(name, count, config));
  }
  const summary = aggregateScenario(samples);
  rawResults[name] = { samples, summary };
  printScenarioSummary(name, count, summary, samples.at(-1));
}

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  config,
  results: rawResults,
};

if (config.jsonOut) {
  const outputPath = path.resolve(repoRoot, config.jsonOut);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`JSON report: ${path.relative(repoRoot, outputPath)}`);
}

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
  writeFixtureFile,
} from './helpers.mjs';

test('large repeated content is externalized, deduplicated, and capture cleanup prevents new orphans', async () => {
  const workspace = makeWorkspace('lcm-artifact-dedup');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ largeContentThreshold: 40, artifactViewChars: 400 }),
    );
    await store.init();

    const sharedText = 'shared artifact token repeated '.repeat(6);

    await createSession(store, workspace, 'a', 1);
    await captureMessage(store, {
      sessionID: 'a',
      messageID: 'm1',
      created: 2,
      parts: [textPart('a', 'm1', 'm1-p', sharedText)],
    });

    await createSession(store, workspace, 'b', 3);
    await captureMessage(store, {
      sessionID: 'b',
      messageID: 'm2',
      created: 4,
      parts: [textPart('b', 'm2', 'm2-p', sharedText)],
    });

    const stats = await store.stats();
    const results = await store.grep({ query: 'shared artifact token', sessionID: 'a', limit: 5 });
    const artifactResult = results.find((result) => result.type.startsWith('artifact:'));

    assert.equal(stats.sharedArtifactBlobCount, 1);
    assert.equal(stats.artifactBlobCount, 1);
    assert.ok(artifactResult);
    const artifactText = await store.artifact({ artifactID: artifactResult.id, chars: 400 });
    assert.match(artifactText, /shared artifact token repeated/);

    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 'a',
        time: 5,
        part: textPart('a', 'm1', 'm1-p', 'short replacement'),
      },
    });
    await store.capture({
      type: 'message.part.updated',
      properties: {
        sessionID: 'b',
        time: 6,
        part: textPart('b', 'm2', 'm2-p', 'other short replacement'),
      },
    });

    const dryRun = await store.gcBlobs({ apply: false });
    const applied = await store.gcBlobs({ apply: true });
    const after = await store.stats();

    assert.match(dryRun, /orphan_blobs=0/);
    assert.match(dryRun, /status=clean/);
    assert.match(applied, /orphan_blobs=0/);
    assert.match(applied, /status=clean/);
    assert.equal(after.orphanArtifactBlobCount, 0);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('search prefers direct message hits, indexes artifact metadata, and falls back to scan', async () => {
  const workspace = makeWorkspace('lcm-search-ranking');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ freshTailMessages: 1, largeContentThreshold: 50 }),
    );
    await store.init();

    const attachmentPath = writeFixtureFile(
      workspace,
      'fixtures/evidence.bin',
      Buffer.from('evidence-bytes-1234'),
    );
    const attachmentText = 'attachment needle phrase '.repeat(5);

    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [textPart('s1', 'm1', 'm1-p', 'ranking phrase exact')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm2',
      created: 3,
      parts: [textPart('s1', 'm2', 'm2-p', 'ranking phrase exact repeated '.repeat(6))],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm3',
      created: 4,
      parts: [textPart('s1', 'm3', 'm3-p', 'bridge note one')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm4',
      created: 5,
      parts: [textPart('s1', 'm4', 'm4-p', 'bridge note two')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm5',
      created: 6,
      parts: [textPart('s1', 'm5', 'm5-p', 'punctuation => fallback')],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm6',
      created: 7,
      parts: [
        toolCompletedPart('s1', 'm6', 'm6-p', 'inspect_file', 'ok', [
          filePart('s1', 'm6', 'attachment-1', attachmentPath, attachmentText),
        ]),
      ],
    });

    await store.buildCompactionContext('s1');

    const ranked = await store.grep({ query: 'ranking phrase exact', sessionID: 's1', limit: 5 });
    const attachmentResults = await store.grep({
      query: 'evidence.bin',
      sessionID: 's1',
      limit: 5,
    });
    const attachmentResult = attachmentResults.find((result) =>
      result.type.startsWith('artifact:file'),
    );
    const fallback = await store.grep({ query: '=>', sessionID: 's1', limit: 3 });

    assert.equal(ranked[0].type, 'user');
    assert.ok(ranked.some((result) => result.type === 'summary'));
    assert.ok(ranked.some((result) => result.type.startsWith('artifact:')));
    assert.ok(attachmentResult);
    const attachmentArtifact = await store.artifact({
      artifactID: attachmentResult.id,
      chars: 400,
    });
    assert.match(attachmentArtifact, /Kind: file/);
    assert.match(attachmentArtifact, /evidence.bin/);
    assert.equal(fallback[0].id, 'm5');
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('privacy controls redact archived text and exclude configured tool and path captures', async () => {
  const workspace = makeWorkspace('lcm-privacy-controls');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({
        largeContentThreshold: 40,
        privacy: {
          excludeToolPrefixes: ['secret_'],
          excludePathPatterns: ['fixtures[/\\\\]private'],
          redactPatterns: ['(', 'ZX729ALBATROSS'],
        },
      }),
    );
    await store.init();

    const privatePath = writeFixtureFile(
      workspace,
      'fixtures/private/report.txt',
      'private file body ZX729ALBATROSS',
    );

    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [textPart('s1', 'm1', 'm1-p', 'invoice issue ZX729ALBATROSS '.repeat(6))],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm2',
      created: 3,
      parts: [
        toolCompletedPart(
          's1',
          'm2',
          'm2-p',
          'secret_fetch_credentials',
          'tool secret ZX729ALBATROSS should never store',
          [filePart('s1', 'm2', 'attachment-1', privatePath, 'attached secret ZX729ALBATROSS')],
        ),
      ],
    });
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm3',
      created: 4,
      parts: [filePart('s1', 'm3', 'm3-p', privatePath, 'private file body ZX729ALBATROSS')],
    });

    const invoiceResults = await store.grep({ query: 'invoice issue', sessionID: 's1', limit: 5 });
    const artifactResult = invoiceResults.find((result) => result.type.startsWith('artifact:'));
    const secretResults = await store.grep({ query: 'ZX729ALBATROSS', sessionID: 's1', limit: 5 });
    const toolResults = await store.grep({
      query: 'should never store',
      sessionID: 's1',
      limit: 5,
    });
    const fileResults = await store.grep({ query: 'private file body', sessionID: 's1', limit: 5 });
    const describe = await store.describe({ sessionID: 's1' });
    const stats = await store.stats();

    assert.ok(artifactResult, 'expected a redacted artifact hit');
    const artifactText = await store.artifact({ artifactID: artifactResult.id, chars: 400 });
    assert.match(artifactText, /\[REDACTED\]/);
    assert.ok(!artifactText.includes('ZX729ALBATROSS'));
    assert.equal(secretResults.length, 0);
    assert.equal(toolResults.length, 0);
    assert.equal(fileResults.length, 0);
    assert.match(describe, /Excluded tool payload by opencode-lcm privacy policy/);
    assert.match(describe, /Excluded file content by opencode-lcm privacy policy/);
    assert.ok(!describe.includes('report.txt'));
    assert.ok(!describe.includes('ZX729ALBATROSS'));
    assert.equal(stats.artifactCount, 1);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

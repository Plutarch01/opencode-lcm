import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveWorkspacePath } from '../dist/workspace-path.js';

function makeWorkspace() {
  const base = os.tmpdir();
  const ws = path.join(base, 'lcm-test-ws-' + Math.random().toString(36).slice(2, 8));
  return { base, ws, sep: path.sep };
}

test('resolves relative paths within workspace', () => {
  const { ws } = makeWorkspace();
  const result = resolveWorkspacePath(ws, 'file.txt');
  assert.equal(result, path.join(ws, 'file.txt'));
});

test('resolves nested relative paths', () => {
  const { ws } = makeWorkspace();
  const result = resolveWorkspacePath(ws, path.join('src', 'file.txt'));
  assert.equal(result, path.join(ws, 'src', 'file.txt'));
});

test('rejects paths that escape workspace', () => {
  const { ws, base } = makeWorkspace();
  assert.throws(
    () => resolveWorkspacePath(ws, path.join('..', 'file.txt')),
    /Path must stay within the workspace/,
  );
  // Also verify it doesn't resolve to something in base
  const escaped = path.join(ws, '..', '..', 'file.txt');
  assert.throws(() => resolveWorkspacePath(ws, escaped), /Path must stay within the workspace/);
});

test('rejects deeply escaped paths', () => {
  const { ws } = makeWorkspace();
  const escaped = path.join('subdir', '..', '..', 'file.txt');
  assert.throws(() => resolveWorkspacePath(ws, escaped), /Path must stay within the workspace/);
});

test('accepts absolute paths within workspace', () => {
  const { ws } = makeWorkspace();
  const absPath = path.join(ws, 'file.txt');
  const result = resolveWorkspacePath(ws, absPath);
  assert.equal(result, absPath);
});

test('accepts relative paths whose segment names start with two dots', () => {
  const { ws } = makeWorkspace();
  const input = path.join('..hidden', 'file.txt');
  const result = resolveWorkspacePath(ws, input);
  assert.equal(result, path.join(ws, '..hidden', 'file.txt'));
});

test('rejects absolute paths outside workspace', () => {
  const { ws, base } = makeWorkspace();
  assert.throws(() => resolveWorkspacePath(ws, base), /Path must stay within the workspace/);
});

test('handles workspace root path', () => {
  const { ws } = makeWorkspace();
  const result = resolveWorkspacePath(ws, '.');
  assert.equal(result, ws);
});

test('handles current directory reference', () => {
  const { ws } = makeWorkspace();
  const result = resolveWorkspacePath(ws, '.' + path.sep + 'file.txt');
  assert.equal(result, path.join(ws, 'file.txt'));
});

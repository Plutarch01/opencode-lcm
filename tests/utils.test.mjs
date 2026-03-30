import assert from 'node:assert/strict';
import test from 'node:test';

import {
  asRecord,
  buildSnippet,
  clamp,
  classifyFileCategory,
  filterIntentTokens,
  firstFiniteNumber,
  formatMetadataValue,
  formatRetentionDays,
  hashContent,
  inferFileExtension,
  inferUrlScheme,
  isAutomaticRetrievalNoise,
  parseJson,
  sanitizeAutomaticRetrievalSourceText,
  sanitizeFtsTokens,
  shortNodeID,
  shouldSuppressLowSignalAutomaticRetrievalAnchor,
  tokenizeQuery,
  truncate,
} from '../dist/utils.js';

// --- asRecord ---

test('asRecord returns object for plain objects', () => {
  assert.ok(asRecord({ a: 1 }));
  assert.equal(asRecord({ a: 1 })?.a, 1);
});

test('asRecord returns undefined for null, arrays, primitives', () => {
  assert.equal(asRecord(null), undefined);
  assert.equal(asRecord(undefined), undefined);
  assert.equal(asRecord([]), undefined);
  assert.equal(asRecord(42), undefined);
  assert.equal(asRecord('str'), undefined);
});

// --- firstFiniteNumber ---

test('firstFiniteNumber extracts first finite number from object values', () => {
  assert.equal(firstFiniteNumber({ a: 'x', b: 42, c: 7 }), 42);
  assert.equal(firstFiniteNumber({ a: Infinity, b: NaN, c: 3 }), 3);
  assert.equal(firstFiniteNumber({ a: 'x' }), undefined);
  assert.equal(firstFiniteNumber(null), undefined);
});

// --- truncate ---

test('truncate shortens long strings', () => {
  assert.equal(truncate('hello world', 5), 'he...');
  assert.equal(truncate('hi', 10), 'hi');
  assert.equal(truncate('abcdef', 6), 'abcdef');
  assert.equal(truncate('abcdefg', 6), 'abc...');
});

// --- shortNodeID ---

test('shortNodeID truncates long IDs', () => {
  const long = 'sum_abc123def456ghi789jkl012mno345_pqr678';
  const short = shortNodeID(long);
  assert.ok(short.length < long.length);
  assert.ok(short.includes('...'));
  assert.equal(shortNodeID('short'), 'short');
});

// --- parseJson ---

test('parseJson parses and types', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('[1,2,3]'), [1, 2, 3]);
});

// --- clamp ---

test('clamp bounds values', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(20, 0, 10), 10);
});

// --- hashContent ---

test('hashContent produces consistent sha256 hex', () => {
  const h1 = hashContent('hello');
  const h2 = hashContent('hello');
  const h3 = hashContent('world');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 64);
});

// --- tokenizeQuery ---

test('tokenizeQuery splits and deduplicates', () => {
  const tokens = tokenizeQuery('foo bar foo baz');
  assert.deepEqual(tokens.sort(), ['bar', 'baz', 'foo']);
});

test('tokenizeQuery ignores non-alphanumeric', () => {
  assert.deepEqual(tokenizeQuery('hello-world!'), ['hello', 'world']);
});

// --- sanitizeFtsTokens ---

test('sanitizeFtsTokens drops reserved words and short tokens', () => {
  assert.deepEqual(sanitizeFtsTokens(['and', 'or', 'sqlite', 'a', 'db']), ['sqlite', 'db']);
});

// --- buildSnippet ---

test('buildSnippet returns truncated content without query', () => {
  const result = buildSnippet('hello world foo bar baz qux', undefined, 20);
  assert.ok(result.length <= 20);
});

test('buildSnippet centers around query match', () => {
  const content = 'prefix context TARGET suffix more text here';
  const result = buildSnippet(content, 'TARGET', 40);
  assert.ok(result.includes('TARGET'));
});

test('buildSnippet handles empty content', () => {
  assert.equal(buildSnippet(''), '');
  assert.equal(buildSnippet('   '), '');
});

// --- sanitizeAutomaticRetrievalSourceText ---

test('sanitizeAutomaticRetrievalSourceText strips system reminders', () => {
  const input = 'hello <system-reminder>secret</system-reminder> world';
  const result = sanitizeAutomaticRetrievalSourceText(input);
  assert.ok(!result.includes('<system-reminder>'));
  assert.ok(result.includes('hello'));
  assert.ok(result.includes('world'));
});

test('sanitizeAutomaticRetrievalSourceText strips archived markers', () => {
  const input = '[Archived by opencode-lcm: older text] actual content';
  const result = sanitizeAutomaticRetrievalSourceText(input);
  assert.ok(!result.includes('Archived by opencode-lcm'));
  assert.ok(result.includes('actual content'));
});

// --- isAutomaticRetrievalNoise ---

test('isAutomaticRetrievalNoise detects noise patterns', () => {
  assert.ok(isAutomaticRetrievalNoise('<system-reminder>'));
  assert.ok(isAutomaticRetrievalNoise('[Archived by opencode-lcm: text]'));
  assert.ok(!isAutomaticRetrievalNoise('hello world'));
});

// --- filterIntentTokens ---

test('filterIntentTokens removes stopwords', () => {
  const result = filterIntentTokens(['the', 'sqlite', 'and', 'database', 'a']);
  assert.deepEqual(result, ['sqlite', 'database']);
});

test('filterIntentTokens keeps short tokens with digits or underscores', () => {
  assert.deepEqual(filterIntentTokens(['v2', 'my_var', 'ok']), ['v2', 'my_var']);
});

// --- shouldSuppressLowSignalAutomaticRetrievalAnchor ---

test('shouldSuppressLowSignal returns false when signal meets minimum', () => {
  assert.equal(shouldSuppressLowSignalAutomaticRetrievalAnchor('sqlite database', 3, 2, 0), false);
});

test('shouldSuppressLowSignal returns false when files present', () => {
  assert.equal(shouldSuppressLowSignalAutomaticRetrievalAnchor('ab', 0, 3, 2), false);
});

test('shouldSuppressLowSignal returns false when question present', () => {
  assert.equal(shouldSuppressLowSignalAutomaticRetrievalAnchor('how to?', 1, 3, 0), false);
});

test('shouldSuppressLowSignal returns true for low-signal short text', () => {
  assert.equal(shouldSuppressLowSignalAutomaticRetrievalAnchor('ok yes', 1, 3, 0), true);
});

// --- inferUrlScheme ---

test('inferUrlScheme extracts scheme', () => {
  assert.equal(inferUrlScheme('https://example.com'), 'https');
  assert.equal(inferUrlScheme('file:///path'), 'file');
  assert.equal(inferUrlScheme('no-scheme'), undefined);
  assert.equal(inferUrlScheme(undefined), undefined);
});

// --- inferFileExtension ---

test('inferFileExtension extracts extension', () => {
  assert.equal(inferFileExtension('foo.ts'), 'ts');
  assert.equal(inferFileExtension('C:\\path\\file.py'), 'py');
  assert.equal(inferFileExtension('noext'), undefined);
  assert.equal(inferFileExtension('.hidden'), undefined);
  assert.equal(inferFileExtension(undefined), undefined);
});

// --- classifyFileCategory ---

test('classifyFileCategory identifies images', () => {
  assert.equal(classifyFileCategory('image/png'), 'image');
  assert.equal(classifyFileCategory('image/jpeg'), 'image');
});

test('classifyFileCategory identifies code', () => {
  assert.equal(classifyFileCategory(undefined, 'ts'), 'code');
  assert.equal(classifyFileCategory(undefined, 'py'), 'code');
});

test('classifyFileCategory identifies pdf', () => {
  assert.equal(classifyFileCategory('application/pdf'), 'pdf');
  assert.equal(classifyFileCategory(undefined, 'pdf'), 'pdf');
});

test('classifyFileCategory identifies structured-data', () => {
  assert.equal(classifyFileCategory(undefined, 'json'), 'structured-data');
  assert.equal(classifyFileCategory(undefined, 'yaml'), 'structured-data');
});

test('classifyFileCategory defaults to binary', () => {
  assert.equal(classifyFileCategory('application/octet-stream'), 'binary');
  assert.equal(classifyFileCategory(undefined, 'bin'), 'binary');
});

// --- formatMetadataValue ---

test('formatMetadataValue handles primitives and arrays', () => {
  assert.equal(formatMetadataValue('hello'), 'hello');
  assert.equal(formatMetadataValue(42), '42');
  assert.equal(formatMetadataValue(true), 'true');
  assert.equal(formatMetadataValue(['a', 'b']), 'a, b');
  assert.equal(formatMetadataValue({ x: 1 }), '{"x":1}');
  assert.equal(formatMetadataValue(null), undefined);
});

// --- formatRetentionDays ---

test('formatRetentionDays formats correctly', () => {
  assert.equal(formatRetentionDays(undefined), 'disabled');
  assert.equal(formatRetentionDays(30), '30');
  assert.equal(formatRetentionDays(0), '0');
});

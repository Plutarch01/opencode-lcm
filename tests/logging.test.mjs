import assert from 'node:assert/strict';
import test from 'node:test';

import { getLogger, setLogger } from '../dist/logging.js';

test('getLogger returns default logger', () => {
  const logger = getLogger();
  assert.ok(typeof logger.debug === 'function');
  assert.ok(typeof logger.info === 'function');
  assert.ok(typeof logger.warn === 'function');
  assert.ok(typeof logger.error === 'function');
});

test('setLogger swaps the logger', () => {
  const calls = [];
  const customLogger = {
    debug(message, context) {
      calls.push({ level: 'debug', message, context });
    },
    info(message, context) {
      calls.push({ level: 'info', message, context });
    },
    warn(message, context) {
      calls.push({ level: 'warn', message, context });
    },
    error(message, context) {
      calls.push({ level: 'error', message, context });
    },
  };

  setLogger(customLogger);
  const logger = getLogger();
  logger.info('test message', { key: 'value' });
  logger.error('error message');

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { level: 'info', message: 'test message', context: { key: 'value' } });
  assert.deepEqual(calls[1], { level: 'error', message: 'error message', context: undefined });

  // Restore default logger
  setLogger(getLogger());
});

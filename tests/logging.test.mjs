import assert from 'node:assert/strict';
import test from 'node:test';

import { getLogger, isStartupLoggingEnabled, setLogger } from '../dist/logging.js';

test('getLogger returns default logger', () => {
  const logger = getLogger();
  assert.ok(typeof logger.debug === 'function');
  assert.ok(typeof logger.info === 'function');
  assert.ok(typeof logger.warn === 'function');
  assert.ok(typeof logger.error === 'function');
});

test('default logger is silent', () => {
  const logger = getLogger();
  const calls = [];
  const original = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  console.debug = (...args) => calls.push({ level: 'debug', args });
  console.info = (...args) => calls.push({ level: 'info', args });
  console.warn = (...args) => calls.push({ level: 'warn', args });
  console.error = (...args) => calls.push({ level: 'error', args });

  try {
    logger.debug('debug message', { key: 'value' });
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');
  } finally {
    console.debug = original.debug;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }

  assert.deepEqual(calls, []);
});

test('setLogger swaps the logger', () => {
  const defaultLogger = getLogger();
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

  setLogger(defaultLogger);
});

test('isStartupLoggingEnabled respects OPENCODE_LCM_STARTUP_LOG', () => {
  const previous = process.env.OPENCODE_LCM_STARTUP_LOG;

  try {
    delete process.env.OPENCODE_LCM_STARTUP_LOG;
    assert.equal(isStartupLoggingEnabled(), false);

    process.env.OPENCODE_LCM_STARTUP_LOG = '1';
    assert.equal(isStartupLoggingEnabled(), true);

    process.env.OPENCODE_LCM_STARTUP_LOG = 'true';
    assert.equal(isStartupLoggingEnabled(), true);

    process.env.OPENCODE_LCM_STARTUP_LOG = 'off';
    assert.equal(isStartupLoggingEnabled(), false);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_LCM_STARTUP_LOG;
    else process.env.OPENCODE_LCM_STARTUP_LOG = previous;
  }
});

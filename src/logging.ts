/**
 * Lightweight structured logging interface for opencode-lcm.
 * Silent by default so plugin logs do not corrupt the host terminal UI.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

let currentLogger: Logger = silentLogger;

export function setLogger(logger: Logger): void {
  currentLogger = logger;
}

export function getLogger(): Logger {
  return currentLogger;
}

export function isStartupLoggingEnabled(): boolean {
  if (typeof process !== 'object' || !process?.env) return false;
  return isTruthyEnvFlag(process.env.OPENCODE_LCM_STARTUP_LOG);
}

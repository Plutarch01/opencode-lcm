/**
 * Lightweight structured logging interface for opencode-lcm.
 * Uses console methods by default but can be swapped for a proper logger.
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

let currentLogger: Logger = {
  debug(message: string, context?: Record<string, unknown>) {
    if (context) {
      console.debug(`[lcm] ${message}`, context);
    } else {
      console.debug(`[lcm] ${message}`);
    }
  },
  info(message: string, context?: Record<string, unknown>) {
    if (context) {
      console.info(`[lcm] ${message}`, context);
    } else {
      console.info(`[lcm] ${message}`);
    }
  },
  warn(message: string, context?: Record<string, unknown>) {
    if (context) {
      console.warn(`[lcm] ${message}`, context);
    } else {
      console.warn(`[lcm] ${message}`);
    }
  },
  error(message: string, context?: Record<string, unknown>) {
    if (context) {
      console.error(`[lcm] ${message}`, context);
    } else {
      console.error(`[lcm] ${message}`);
    }
  },
};

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

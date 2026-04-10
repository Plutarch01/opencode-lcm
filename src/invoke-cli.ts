import { spawn } from 'node:child_process';

export interface InvokeCLIOptions {
  command: string;
  args: string[];
  stdin?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 10_000;

function truncateOutput(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

function getErrorContext(stderr: string): string {
  const trimmed = stderr.trim();

  return trimmed.length > 0 ? `\nstderr: ${trimmed}` : '';
}

export class CLISpawnError extends Error {
  readonly command: string;
  readonly cause: Error;

  constructor(command: string, cause: Error) {
    super(`Failed to spawn CLI command: ${command}${getErrorContext(cause.message)}`);
    this.name = 'CLISpawnError';
    this.command = command;
    this.cause = cause;
  }
}

export class CLITimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;
  readonly stderr: string;

  constructor(command: string, timeoutMs: number, stderr: string) {
    super(`CLI command timed out after ${timeoutMs}ms: ${command}${getErrorContext(stderr)}`);
    this.name = 'CLITimeoutError';
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.stderr = stderr;
  }
}

export class CLIExitError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stderr: string) {
    super(
      `CLI command exited with code ${exitCode ?? 'unknown'}: ${command}${getErrorContext(stderr)}`,
    );
    this.name = 'CLIExitError';
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export async function invokeCLI(options: InvokeCLIOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const formattedCommand = formatCommand(options.command, options.args);
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const child = spawn(options.command, options.args, {
        stdio: 'pipe',
        signal: controller.signal,
      });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        stdout = truncateOutput(stdout + chunk, maxOutputChars);
      });

      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.once('error', (error) => {
        if (timedOut || error.name === 'AbortError') {
          reject(new CLITimeoutError(formattedCommand, timeoutMs, stderr));
          return;
        }

        reject(new CLISpawnError(formattedCommand, error));
      });

      child.once('close', (code) => {
        if (timedOut) {
          reject(new CLITimeoutError(formattedCommand, timeoutMs, stderr));
          return;
        }

        if (code !== 0) {
          reject(new CLIExitError(formattedCommand, code, stderr));
          return;
        }

        resolve(stdout);
      });

      if (options.stdin !== undefined) {
        child.stdin.end(options.stdin);
        return;
      }

      child.stdin.end();
    });
  } finally {
    clearTimeout(timeout);
  }
}

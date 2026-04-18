import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import type { Event } from '@opencode-ai/sdk';

import type {
  ApplyLimitInput,
  ArtifactInput,
  DescribeInput,
  DoctorInput,
  ExpandInput,
  ExportSnapshotInput,
  GrepInput,
  ImportSnapshotInput,
  LcmStore,
  LimitInput,
  PinSessionInput,
  RetentionInput,
  SessionIDInput,
} from './lcm-store.js';
import type { ConversationMessage, OpencodeLcmOptions, SearchResult, StoreStats } from './types.js';

type SidecarResponse =
  | { id: number; result: unknown }
  | { id: number; error: { name?: string; message: string; stack?: string } };

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type TransformResult = {
  changed: boolean;
  messages: ConversationMessage[];
};

type Refable = {
  ref?: () => unknown;
  unref?: () => unknown;
};

function formatSidecarError(error: { name?: string; message: string; stack?: string }): Error {
  const wrapped = new Error(error.message);
  wrapped.name = error.name ?? 'NodeSidecarError';
  if (error.stack) wrapped.stack = error.stack;
  return wrapped;
}

function nodeExecutable(): string {
  return process.env.OPENCODE_LCM_NODE_PATH || process.env.NODE || 'node';
}

function localSystemHint(options: OpencodeLcmOptions): string | undefined {
  if (!options.systemHint) return undefined;

  return [
    'Archived session state may exist outside the active prompt.',
    'opencode-lcm may automatically recall archived context when it looks relevant to the current turn.',
    'Use lcm_describe, lcm_grep, lcm_resume, lcm_expand, or lcm_artifact only when deeper archive inspection is still needed.',
    'Keep ctx_* usage selective and treat those calls as infrastructure, not task intent.',
  ].join(' ');
}

export class NodeSidecarLcmStore implements LcmStore {
  private child?: ChildProcessWithoutNullStreams;
  private nextID = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private closed = false;

  constructor(
    private readonly projectDir: string,
    private readonly options: OpencodeLcmOptions,
  ) {}

  async init(): Promise<void> {
    this.ensureStarted();
    await this.request('init', {
      projectDir: this.projectDir,
      options: this.options,
    });
  }

  close(): void {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;

    if (child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ id: this.nextID++, method: 'close' })}\n`);
    }
    child.kill();
  }

  async captureDeferred(event: Event): Promise<void> {
    await this.request('captureDeferred', event);
  }

  async stats(): Promise<StoreStats> {
    return (await this.request('stats', undefined)) as StoreStats;
  }

  async automaticRetrievalDebug(sessionID?: string): Promise<string> {
    return (await this.request('automaticRetrievalDebug', sessionID)) as string;
  }

  async resume(sessionID?: string): Promise<string> {
    return (await this.request('resume', sessionID)) as string;
  }

  async grep(input: GrepInput): Promise<SearchResult[]> {
    return (await this.request('grep', input)) as SearchResult[];
  }

  async describe(input?: DescribeInput): Promise<string> {
    return (await this.request('describe', input)) as string;
  }

  async lineage(sessionID?: string): Promise<string> {
    return (await this.request('lineage', sessionID)) as string;
  }

  async pinSession(input: PinSessionInput): Promise<string> {
    return (await this.request('pinSession', input)) as string;
  }

  async unpinSession(input: SessionIDInput): Promise<string> {
    return (await this.request('unpinSession', input)) as string;
  }

  async expand(input: ExpandInput): Promise<string> {
    return (await this.request('expand', input)) as string;
  }

  async artifact(input: ArtifactInput): Promise<string> {
    return (await this.request('artifact', input)) as string;
  }

  async blobStats(input: LimitInput): Promise<string> {
    return (await this.request('blobStats', input)) as string;
  }

  async gcBlobs(input: ApplyLimitInput): Promise<string> {
    return (await this.request('gcBlobs', input)) as string;
  }

  async doctor(input?: DoctorInput): Promise<string> {
    return (await this.request('doctor', input)) as string;
  }

  async retentionReport(input?: RetentionInput): Promise<string> {
    return (await this.request('retentionReport', input)) as string;
  }

  async retentionPrune(input: RetentionInput): Promise<string> {
    return (await this.request('retentionPrune', input)) as string;
  }

  async exportSnapshot(input: ExportSnapshotInput): Promise<string> {
    return (await this.request('exportSnapshot', input)) as string;
  }

  async importSnapshot(input: ImportSnapshotInput): Promise<string> {
    return (await this.request('importSnapshot', input)) as string;
  }

  async transformMessages(messages: ConversationMessage[]): Promise<boolean> {
    const result = (await this.request('transformMessages', messages)) as TransformResult;
    messages.splice(0, messages.length, ...result.messages);
    return result.changed;
  }

  async buildCompactionContext(sessionID: string): Promise<string | undefined> {
    return (await this.request('buildCompactionContext', sessionID)) as string | undefined;
  }

  systemHint(): string | undefined {
    return localSystemHint(this.options);
  }

  private ensureStarted(): void {
    if (this.child) return;
    const scriptPath = fileURLToPath(new URL('./node-sidecar.js', import.meta.url));
    const child = spawn(nodeExecutable(), ['--no-warnings', scriptPath], {
      env: {
        ...process.env,
        OPENCODE_LCM_SQLITE_RUNTIME: 'node',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-4000);
    });
    child.once('error', (error) => this.rejectAll(error));
    child.once('exit', (code, signal) => {
      if (this.closed) return;
      const suffix = this.stderrBuffer ? `\nSidecar stderr:\n${this.stderrBuffer}` : '';
      this.rejectAll(new Error(`opencode-lcm Node sidecar exited code=${code} signal=${signal}${suffix}`));
    });
    this.updateRefs();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    this.ensureStarted();
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error('opencode-lcm Node sidecar is not writable'));
    }

    const id = this.nextID;
    this.nextID += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.updateRefs();
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        this.updateRefs();
        reject(error);
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;

      let response: SidecarResponse;
      try {
        response = JSON.parse(line) as SidecarResponse;
      } catch (error) {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
        continue;
      }

      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      this.updateRefs();

      if ('error' in response) pending.reject(formatSidecarError(response.error));
      else pending.resolve(response.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.updateRefs();
  }

  private updateRefs(): void {
    const child = this.child;
    if (!child) return;
    const method = this.pending.size > 0 ? 'ref' : 'unref';
    child[method]();
    this.setStreamRef(child.stdin, method);
    this.setStreamRef(child.stdout, method);
    this.setStreamRef(child.stderr, method);
  }

  private setStreamRef(stream: unknown, method: 'ref' | 'unref'): void {
    const refable = stream as Refable;
    refable[method]?.();
  }

  async waitForExitForTests(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await once(child, 'exit');
  }
}

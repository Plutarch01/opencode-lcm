import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import type { Event } from '@opencode-ai/sdk';
import { DEFERRED_PART_UPDATE_DELAY_MS } from './constants.js';

import type {
  ApplyLimitInput,
  ArtifactInput,
  CompactInput,
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
import { getLogger } from './logging.js';
import { getDeferredPartUpdateKey } from './store.js';
import type { ConversationMessage, OpencodeLcmOptions, SearchResult, StoreStats } from './types.js';

type SidecarResponse =
  | { id: number; result: unknown }
  | { id: number; error: { name?: string; message: string; stack?: string } };

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
};

const SIDECAR_REQUEST_TIMEOUT_MS = (() => {
  const configured = process.env.OPENCODE_LCM_SIDECAR_TIMEOUT_MS;
  if (configured === undefined) return 300_000;
  const raw = Number(configured);
  return Number.isFinite(raw) && raw >= 0 ? raw : 300_000;
})();

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
  private restartBarrier: Promise<void> = Promise.resolve();
  private restartError?: Error;
  private terminatingChild?: ChildProcessWithoutNullStreams;
  private readonly pendingPartUpdates = new Map<string, Event>();
  private pendingPartUpdateTimer?: NodeJS.Timeout;
  private pendingPartUpdateFlushPromise?: Promise<void>;

  constructor(
    private readonly projectDir: string,
    private readonly options: OpencodeLcmOptions,
  ) {}

  async init(): Promise<void> {
    await this.request('init', {
      projectDir: this.projectDir,
      options: this.options,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.clearPendingPartUpdateTimer();
    if (this.pendingPartUpdateFlushPromise) await this.pendingPartUpdateFlushPromise;
    if (this.pendingPartUpdates.size > 0) await this.flushPendingPartUpdates();
    this.closed = true;
    const child = this.child;
    this.rejectAll(new Error('opencode-lcm Node sidecar closed'));
    this.child = undefined;
    if (!child) {
      await this.restartBarrier;
      if (this.terminatingChild) await this.forceTerminateAndWait(this.terminatingChild);
      return;
    }

    if (child.stdin.writable) {
      child.stdin.end(`${JSON.stringify({ id: this.nextID++, method: 'close' })}\n`);
    } else {
      await this.forceTerminateAndWait(child);
      return;
    }

    const exited = once(child, 'exit').then(
      () => true,
      () => true,
    );
    const graceful = await Promise.race([
      exited,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!graceful) await this.forceTerminateAndWait(child);
  }

  async captureDeferred(event: Event): Promise<void> {
    const key = getDeferredPartUpdateKey(event);
    if (key) {
      this.pendingPartUpdates.set(key, event);
      this.schedulePendingPartUpdateFlush();
      return;
    }

    if (event.type === 'message.part.removed') {
      this.pendingPartUpdates.delete(
        `${event.properties.sessionID}:${event.properties.messageID}:${event.properties.partID}`,
      );
    } else if (event.type === 'message.removed') {
      this.clearPendingPartUpdates(`${event.properties.sessionID}:${event.properties.messageID}:`);
    } else if (event.type === 'session.deleted') {
      const sessionID = event.properties.info.id;
      this.clearPendingPartUpdates(`${sessionID}:`);
    }

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

  async grep(input: GrepInput): Promise<SearchResult[] | string> {
    return (await this.request('grep', input)) as SearchResult[] | string;
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

  async compact(input: CompactInput): Promise<string> {
    return (await this.request('compact', input)) as string;
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

  private schedulePendingPartUpdateFlush(): void {
    if (this.pendingPartUpdateTimer || this.pendingPartUpdates.size === 0) return;
    this.pendingPartUpdateTimer = setTimeout(() => {
      this.pendingPartUpdateTimer = undefined;
      void this.flushPendingPartUpdates().catch((error) => {
        getLogger().warn('Deferred sidecar part-update flush failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, DEFERRED_PART_UPDATE_DELAY_MS);
    this.pendingPartUpdateTimer.unref?.();
  }

  private clearPendingPartUpdateTimer(): void {
    if (!this.pendingPartUpdateTimer) return;
    clearTimeout(this.pendingPartUpdateTimer);
    this.pendingPartUpdateTimer = undefined;
  }

  private clearPendingPartUpdates(prefix: string): void {
    for (const key of this.pendingPartUpdates.keys()) {
      if (key.startsWith(prefix)) this.pendingPartUpdates.delete(key);
    }
    if (this.pendingPartUpdates.size === 0) this.clearPendingPartUpdateTimer();
  }

  private async flushPendingPartUpdates(): Promise<void> {
    if (this.pendingPartUpdateFlushPromise) return this.pendingPartUpdateFlushPromise;
    if (this.pendingPartUpdates.size === 0) return;
    this.clearPendingPartUpdateTimer();
    this.pendingPartUpdateFlushPromise = (async () => {
      while (this.pendingPartUpdates.size > 0) {
        const batch = [...this.pendingPartUpdates.values()];
        this.pendingPartUpdates.clear();
        for (const [index, event] of batch.entries()) {
          try {
            await this.request('captureImmediate', event);
          } catch (error) {
            for (const pendingEvent of batch.slice(index)) {
              const key = getDeferredPartUpdateKey(pendingEvent);
              if (key && !this.pendingPartUpdates.has(key)) {
                this.pendingPartUpdates.set(key, pendingEvent);
              }
            }
            throw error;
          }
        }
      }
    })().finally(() => {
      this.pendingPartUpdateFlushPromise = undefined;
      if (this.pendingPartUpdates.size > 0) this.schedulePendingPartUpdateFlush();
    });
    return this.pendingPartUpdateFlushPromise;
  }

  private ensureStarted(): void {
    if (this.closed) throw new Error('opencode-lcm Node sidecar is closed');
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
    child.stdout.on('data', (chunk) => this.handleStdout(child, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-4000);
    });
    child.once('error', (error) => this.failChild(child, error));
    child.once('exit', (code, signal) => {
      if (this.closed || this.child !== child) return;
      const suffix = this.stderrBuffer ? `\nSidecar stderr:\n${this.stderrBuffer}` : '';
      this.failChild(
        child,
        new Error(`opencode-lcm Node sidecar exited code=${code} signal=${signal}${suffix}`),
        false,
      );
    });
    this.updateRefs();
  }

  private async request(
    method: string,
    params: unknown,
    timeoutMs: number = SIDECAR_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (
      method !== 'captureDeferred' &&
      method !== 'captureImmediate' &&
      method !== 'init' &&
      method !== 'close'
    ) {
      if (this.pendingPartUpdateFlushPromise) await this.pendingPartUpdateFlushPromise;
      if (this.pendingPartUpdates.size > 0) await this.flushPendingPartUpdates();
    }
    await this.restartBarrier;
    if (this.restartError) throw this.restartError;
    this.ensureStarted();
    const child = this.child;
    if (!child?.stdin.writable) {
      return Promise.reject(new Error('opencode-lcm Node sidecar is not writable'));
    }

    const id = this.nextID;
    this.nextID += 1;

    return new Promise((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject };
      this.pending.set(id, entry);
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.get(id) !== entry) return;
          this.failChild(
            child,
            new Error(`opencode-lcm sidecar request '${method}' timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
      }
      this.updateRefs();
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        if (this.pending.get(id) !== entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        this.pending.delete(id);
        this.updateRefs();
        reject(error);
      });
    });
  }

  private handleStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
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
      if (pending.timer) clearTimeout(pending.timer);

      if ('error' in response) pending.reject(formatSidecarError(response.error));
      else pending.resolve(response.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.updateRefs();
  }

  private failChild(child: ChildProcessWithoutNullStreams, error: Error, terminate = true): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.rejectAll(error);
    if (terminate && child.exitCode === null) {
      this.terminatingChild = child;
      const exited = once(child, 'exit').then(
        () => true,
        () => true,
      );
      this.restartBarrier = Promise.race([
        exited,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]).then((didExit) => {
        if (didExit && this.terminatingChild === child) {
          this.terminatingChild = undefined;
        } else if (!didExit) {
          this.restartError = new Error(
            'opencode-lcm sidecar did not exit after termination; restart the plugin before retrying',
          );
        }
      });
      child.kill();
    }
  }

  private async forceTerminateAndWait(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null) {
      if (this.terminatingChild === child) this.terminatingChild = undefined;
      return;
    }
    const exited = once(child, 'exit').then(
      () => true,
      () => true,
    );
    child.kill('SIGKILL');
    const didExit = await Promise.race([
      exited,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!didExit && child.exitCode === null) {
      throw new Error('opencode-lcm sidecar did not exit after forced termination');
    }
    if (this.terminatingChild === child) this.terminatingChild = undefined;
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

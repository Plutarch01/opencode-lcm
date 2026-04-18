import { createInterface } from 'node:readline';

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
  LimitInput,
  PinSessionInput,
  RetentionInput,
  SessionIDInput,
} from './lcm-store.js';
import { SqliteLcmStore } from './store.js';
import type { ConversationMessage, OpencodeLcmOptions } from './types.js';

type RequestMessage = {
  id: number;
  method: string;
  params?: unknown;
};

let store: SqliteLcmStore | undefined;
let chain = Promise.resolve();

function writeResponse(id: number, body: { result: unknown } | { error: unknown }): void {
  process.stdout.write(`${JSON.stringify({ id, ...body })}\n`);
}

function serializeError(error: unknown): { name?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

function requireStore(): SqliteLcmStore {
  if (!store) throw new Error('opencode-lcm sidecar store is not initialized');
  return store;
}

async function handleRequest(request: RequestMessage): Promise<unknown> {
  switch (request.method) {
    case 'init': {
      const params = request.params as { projectDir: string; options: OpencodeLcmOptions };
      store = new SqliteLcmStore(params.projectDir, params.options);
      await store.init();
      return true;
    }
    case 'close':
      store?.close();
      store = undefined;
      process.exitCode = 0;
      return true;
    case 'captureDeferred':
      await requireStore().captureDeferred(request.params as Event);
      return true;
    case 'stats':
      return await requireStore().stats();
    case 'automaticRetrievalDebug':
      return await requireStore().automaticRetrievalDebug(request.params as string | undefined);
    case 'resume':
      return await requireStore().resume(request.params as string | undefined);
    case 'grep':
      return await requireStore().grep(request.params as GrepInput);
    case 'describe':
      return await requireStore().describe(request.params as DescribeInput | undefined);
    case 'lineage':
      return await requireStore().lineage(request.params as string | undefined);
    case 'pinSession':
      return await requireStore().pinSession(request.params as PinSessionInput);
    case 'unpinSession':
      return await requireStore().unpinSession(request.params as SessionIDInput);
    case 'expand':
      return await requireStore().expand(request.params as ExpandInput);
    case 'artifact':
      return await requireStore().artifact(request.params as ArtifactInput);
    case 'blobStats':
      return await requireStore().blobStats(request.params as LimitInput);
    case 'gcBlobs':
      return await requireStore().gcBlobs(request.params as ApplyLimitInput);
    case 'doctor':
      return await requireStore().doctor(request.params as DoctorInput | undefined);
    case 'retentionReport':
      return await requireStore().retentionReport(request.params as RetentionInput | undefined);
    case 'retentionPrune':
      return await requireStore().retentionPrune(request.params as RetentionInput);
    case 'exportSnapshot':
      return await requireStore().exportSnapshot(request.params as ExportSnapshotInput);
    case 'importSnapshot':
      return await requireStore().importSnapshot(request.params as ImportSnapshotInput);
    case 'transformMessages': {
      const messages = request.params as ConversationMessage[];
      const changed = await requireStore().transformMessages(messages);
      return { changed, messages };
    }
    case 'buildCompactionContext':
      return await requireStore().buildCompactionContext(request.params as string);
    default:
      throw new Error(`Unknown opencode-lcm sidecar method: ${request.method}`);
  }
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

rl.on('line', (line) => {
  chain = chain.then(async () => {
    const request = JSON.parse(line) as RequestMessage;
    try {
      const result = await handleRequest(request);
      writeResponse(request.id, { result });
    } catch (error) {
      writeResponse(request.id, { error: serializeError(error) });
    }
  });
});

rl.on('close', () => {
  store?.close();
});

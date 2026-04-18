import type { Event } from '@opencode-ai/sdk';

import type { ConversationMessage, SearchResult, StoreStats } from './types.js';

export type GrepInput = {
  query: string;
  sessionID?: string;
  scope?: string;
  limit?: number;
};

export type DescribeInput = {
  sessionID?: string;
  scope?: string;
};

export type ExpandInput = {
  sessionID?: string;
  nodeID?: string;
  query?: string;
  depth?: number;
  messageLimit?: number;
  includeRaw?: boolean;
};

export type ArtifactInput = {
  artifactID: string;
  chars?: number;
};

export type LimitInput = {
  limit?: number;
};

export type ApplyLimitInput = {
  apply?: boolean;
  limit?: number;
};

export type DoctorInput = {
  apply?: boolean;
  sessionID?: string;
  limit?: number;
};

export type RetentionInput = {
  apply?: boolean;
  staleSessionDays?: number;
  deletedSessionDays?: number;
  orphanBlobDays?: number;
  limit?: number;
};

export type ExportSnapshotInput = {
  filePath: string;
  sessionID?: string;
  scope?: string;
};

export type ImportSnapshotInput = {
  filePath: string;
  mode: 'merge' | 'replace';
  worktreeMode: 'auto' | 'preserve' | 'current';
};

export type PinSessionInput = {
  sessionID?: string;
  reason?: string;
};

export type SessionIDInput = {
  sessionID?: string;
};

export type LcmStore = {
  init(): Promise<void>;
  close(): void;
  captureDeferred(event: Event): Promise<void>;
  stats(): Promise<StoreStats>;
  automaticRetrievalDebug(sessionID?: string): Promise<string>;
  resume(sessionID?: string): Promise<string>;
  grep(input: GrepInput): Promise<SearchResult[]>;
  describe(input?: DescribeInput): Promise<string>;
  lineage(sessionID?: string): Promise<string>;
  pinSession(input: PinSessionInput): Promise<string>;
  unpinSession(input: SessionIDInput): Promise<string>;
  expand(input: ExpandInput): Promise<string>;
  artifact(input: ArtifactInput): Promise<string>;
  blobStats(input: LimitInput): Promise<string>;
  gcBlobs(input: ApplyLimitInput): Promise<string>;
  doctor(input?: DoctorInput): Promise<string>;
  retentionReport(input?: RetentionInput): Promise<string>;
  retentionPrune(input: RetentionInput): Promise<string>;
  exportSnapshot(input: ExportSnapshotInput): Promise<string>;
  importSnapshot(input: ImportSnapshotInput): Promise<string>;
  transformMessages(messages: ConversationMessage[]): Promise<boolean>;
  buildCompactionContext(sessionID: string): Promise<string | undefined>;
  systemHint(): string | undefined;
};

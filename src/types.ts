import type { Message, Part } from "@opencode-ai/sdk";

export type InteropOptions = {
  contextMode: boolean;
  neverOverrideCompactionPrompt: boolean;
  ignoreToolPrefixes: string[];
};

export type ScopeName = "session" | "root" | "worktree" | "all";

export type ScopeDefaults = {
  grep: ScopeName;
  describe: ScopeName;
};

export type ScopeProfile = {
  worktree: string;
  grep?: ScopeName;
  describe?: ScopeName;
};

export type RetentionPolicyOptions = {
  staleSessionDays?: number;
  deletedSessionDays?: number;
  orphanBlobDays?: number;
};

export type AutomaticRetrievalScopeBudgets = {
  session: number;
  root: number;
  worktree: number;
  all: number;
};

export type AutomaticRetrievalStopOptions = {
  targetHits: number;
  stopOnFirstScopeWithHits: boolean;
};

export type AutomaticRetrievalOptions = {
  enabled: boolean;
  maxChars: number;
  minTokens: number;
  maxMessageHits: number;
  maxSummaryHits: number;
  maxArtifactHits: number;
  scopeOrder: ScopeName[];
  scopeBudgets: AutomaticRetrievalScopeBudgets;
  stop: AutomaticRetrievalStopOptions;
};

export type OpencodeLcmOptions = {
  interop: InteropOptions;
  scopeDefaults: ScopeDefaults;
  scopeProfiles: ScopeProfile[];
  retention: RetentionPolicyOptions;
  automaticRetrieval: AutomaticRetrievalOptions;
  compactContextLimit: number;
  systemHint: boolean;
  storeDir?: string;
  freshTailMessages: number;
  minMessagesForTransform: number;
  summaryCharBudget: number;
  partCharBudget: number;
  largeContentThreshold: number;
  artifactPreviewChars: number;
  artifactViewChars: number;
  binaryPreviewProviders: string[];
  previewBytePeek: number;
};

export type CapturedEvent = {
  id: string;
  type: string;
  sessionID?: string;
  timestamp: number;
  payload: unknown;
};

export type SearchResult = {
  id: string;
  type: string;
  sessionID?: string;
  timestamp: number;
  snippet: string;
};

export type StoreStats = {
  schemaVersion: number;
  totalEvents: number;
  sessionCount: number;
  latestEventAt?: number;
  eventTypes: Record<string, number>;
  summaryNodeCount: number;
  summaryStateCount: number;
  rootSessionCount: number;
  branchedSessionCount: number;
  artifactCount: number;
  artifactBlobCount: number;
  sharedArtifactBlobCount: number;
  orphanArtifactBlobCount: number;
  worktreeCount: number;
  pinnedSessionCount: number;
};

export type ConversationMessage = {
  info: Message;
  parts: Part[];
};

export type NormalizedSession = {
  sessionID: string;
  title?: string;
  directory?: string;
  parentSessionID?: string;
  rootSessionID?: string;
  lineageDepth?: number;
  pinned?: boolean;
  pinReason?: string;
  updatedAt: number;
  compactedAt?: number;
  deleted?: boolean;
  eventCount: number;
  messages: ConversationMessage[];
};

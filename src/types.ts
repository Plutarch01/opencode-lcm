import type { Message, Part } from '@opencode-ai/sdk';

export type InteropOptions = {
  contextMode: boolean;
  neverOverrideCompactionPrompt: boolean;
  ignoreToolPrefixes: string[];
};

export type ScopeName = 'session' | 'root' | 'worktree' | 'all';

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

export type PrivacyOptions = {
  excludeToolPrefixes: string[];
  excludePathPatterns: string[];
  redactPatterns: string[];
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

export type SummaryStrategyName = 'deterministic-v1' | 'deterministic-v2';

export type SummaryV2Options = {
  strategy: SummaryStrategyName;
  perMessageBudget: number;
};

export type OpencodeLcmOptions = {
  interop: InteropOptions;
  scopeDefaults: ScopeDefaults;
  scopeProfiles: ScopeProfile[];
  retention: RetentionPolicyOptions;
  privacy: PrivacyOptions;
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
  summaryV2: SummaryV2Options;
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
  dbBytes: number;
  walBytes: number;
  shmBytes: number;
  totalBytes: number;
  prunableEventCount: number;
  prunableEventTypes: Record<string, number>;
  messageFtsCount: number;
  summaryFtsCount: number;
  artifactFtsCount: number;
};

export type AutomaticRetrievalDebugScopeStat = {
  scope: string;
  budget: number;
  rawResults: number;
  selectedHits: number;
};

export type AutomaticRetrievalDebugHit = {
  kind: 'message' | 'summary' | 'artifact';
  id: string;
  label: string;
  sessionID?: string;
  snippet: string;
};

export type AutomaticRetrievalDebugInfo = {
  sessionID: string;
  status:
    | 'disabled'
    | 'below-transform-threshold'
    | 'no-window'
    | 'no-summary-roots'
    | 'no-query'
    | 'no-hit-quota'
    | 'no-hits'
    | 'recalled';
  anchorMessageID?: string;
  anchorRole?: string;
  archivedCount?: number;
  recentCount?: number;
  queryTokens: string[];
  queries: string[];
  searchedScopes: ScopeName[];
  rawResultCount: number;
  hitCount: number;
  allowedHits: number;
  targetHits: number;
  stopReason: string;
  scopeStats: AutomaticRetrievalDebugScopeStat[];
  hits: AutomaticRetrievalDebugHit[];
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

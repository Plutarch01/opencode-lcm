// V2-compatible types used by the store layer (JSON-serializable shapes)
// These types capture all properties the store code accesses. Values are unknown
// to allow JSON deserialization; the store code uses type assertions where needed.

export type MessageTime = {
  created: number;
  [key: string]: unknown;
};

export type Message = {
  id: string;
  sessionID: string;
  role: string;
  title?: string;
  directory?: string;
  parentID?: string;
  time: MessageTime;
  [key: string]: unknown;
};

export type Part = {
  id: string;
  messageID: string;
  sessionID: string;
  type: string;
  text?: string;
  state: PartState;
  files: string[];
  source: PartSource;
  filename?: string;
  url?: string;
  mime?: string;
  value?: string;
  start?: number;
  end?: number;
  path?: string;
  created?: number;
  tool?: string;
  metadata?: Record<string, unknown>;
  snapshot?: string;
  prompt?: string;
  description?: string;
  agent?: string;
  name?: string;
  [key: string]: unknown;
};

export type PartSource = {
  path?: string;
  text?: { value?: string; start?: number; end?: number };
  value?: string;
  start?: number;
  end?: number;
  type?: string;
  [key: string]: unknown;
};

export type PartState = {
  attachments?: Part[];
  status?: string;
  title?: string;
  input?: unknown;
  output: string;
  error: string;
  metadata?: unknown;
  [key: string]: unknown;
};

export type Properties = {
  part: Part;
  info: Message;
  sessionID?: string;
  messageID?: string;
  partID?: string;
  id?: string;
  time?: { created?: number };
  [key: string]: unknown;
};

export type InteropOptions = {
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

export type SummaryStrategyName = 'deterministic-v1' | 'deterministic-v2' | 'deterministic-v3';

export type SummaryV2Options = {
  strategy: SummaryStrategyName;
  perMessageBudget: number;
};

export type RuntimeSafetyOptions = {
  /** Deprecated on Bun+Windows: config is reported for diagnostics but cannot bypass the sidecar. */
  allowUnsafeBunWindows: boolean;
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
  runtimeSafety: RuntimeSafetyOptions;
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
  nodeID?: string;
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
  recovery?: { reason: string; at: number; quarantinedFiles: string[] };
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

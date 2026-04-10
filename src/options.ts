import type {
  AutomaticRetrievalOptions,
  AutomaticRetrievalScopeBudgets,
  AutomaticRetrievalStopOptions,
  InteropOptions,
  LlmCliOptions,
  OpencodeLcmOptions,
  PrivacyOptions,
  RetentionPolicyOptions,
  ScopeDefaults,
  ScopeName,
  ScopeProfile,
  SummaryStrategyName,
  SummaryV2Options,
} from './types.js';

const DEFAULT_INTEROP: InteropOptions = {
  contextMode: true,
  neverOverrideCompactionPrompt: true,
  ignoreToolPrefixes: ['ctx_'],
};

const DEFAULT_SCOPE_DEFAULTS: ScopeDefaults = {
  grep: 'session',
  describe: 'session',
};

const DEFAULT_RETENTION: RetentionPolicyOptions = {
  staleSessionDays: undefined,
  deletedSessionDays: 30,
  orphanBlobDays: 14,
};

const DEFAULT_PRIVACY: PrivacyOptions = {
  excludeToolPrefixes: [],
  excludePathPatterns: [],
  redactPatterns: [],
};

const DEFAULT_AUTOMATIC_RETRIEVAL: AutomaticRetrievalOptions = {
  enabled: true,
  maxChars: 900,
  minTokens: 2,
  maxMessageHits: 2,
  maxSummaryHits: 1,
  maxArtifactHits: 1,
  scopeOrder: ['session', 'root', 'worktree'],
  scopeBudgets: {
    session: 16,
    root: 12,
    worktree: 8,
    all: 6,
  },
  stop: {
    targetHits: 3,
    stopOnFirstScopeWithHits: false,
  },
};

export const DEFAULT_SUMMARY_V2: SummaryV2Options = {
  strategy: 'deterministic-v2',
  maxChars: 260,
  includeAllMessages: true,
  perMessageBudget: 110,
};

/**
 * Default LLM CLI backend: `opencode run` using the host's configured provider.
 *
 * Two supported invocation patterns:
 *   1. `opencode run --pure -m <provider/model>` (default) — reuses host config, no extra setup.
 *      The LCM plugin is disabled via `--pure` to prevent recursive summarization.
 *   2. Any CLI tool the user installs (llm, ollama, claude) — configured via options overrides.
 *
 * Users override via opencode config: `llmCli: { enabled: true, command: 'llm', args: [...], ... }`
 */
export const DEFAULT_LLM_CLI: LlmCliOptions = {
  enabled: false,
  command: 'opencode',
  args: ['run', '--pure', '--format', 'default', '-m', '{{MODEL}}'],
  model: 'anthropic/claude-haiku-4-5',
  promptMode: 'arg',
  timeoutMs: 30_000,
  maxPromptChars: 8_000,
  fallbackOnError: true,
  asyncEnhancement: true,
};

export const DEFAULT_OPTIONS: OpencodeLcmOptions = {
  interop: DEFAULT_INTEROP,
  scopeDefaults: DEFAULT_SCOPE_DEFAULTS,
  scopeProfiles: [],
  retention: DEFAULT_RETENTION,
  privacy: DEFAULT_PRIVACY,
  automaticRetrieval: DEFAULT_AUTOMATIC_RETRIEVAL,
  compactContextLimit: 1200,
  systemHint: true,
  freshTailMessages: 10,
  minMessagesForTransform: 16,
  summaryCharBudget: 1500,
  partCharBudget: 160,
  largeContentThreshold: 1200,
  artifactPreviewChars: 220,
  artifactViewChars: 4000,
  binaryPreviewProviders: [
    'fingerprint',
    'byte-peek',
    'image-dimensions',
    'pdf-metadata',
    'zip-metadata',
  ],
  previewBytePeek: 16,
  summaryV2: DEFAULT_SUMMARY_V2,
  llmCli: DEFAULT_LLM_CLI,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const next = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return next.length > 0 ? next : fallback;
}

function asScopeName(value: unknown, fallback: ScopeName): ScopeName {
  return value === 'session' || value === 'root' || value === 'worktree' || value === 'all'
    ? value
    : fallback;
}

function asScopeNameArray(value: unknown, fallback: ScopeName[]): ScopeName[] {
  if (!Array.isArray(value)) return fallback;
  const result: ScopeName[] = [];

  for (const item of value) {
    if (item !== 'session' && item !== 'root' && item !== 'worktree' && item !== 'all') continue;
    if (result.includes(item)) continue;
    result.push(item);
  }

  return result.length > 0 ? result : fallback;
}

function asScopeDefaults(value: unknown, fallback: ScopeDefaults): ScopeDefaults {
  const record = asRecord(value);
  return {
    grep: asScopeName(record?.grep, fallback.grep),
    describe: asScopeName(record?.describe, fallback.describe),
  };
}

function asScopeProfiles(value: unknown): ScopeProfile[] {
  if (!Array.isArray(value)) return [];

  const result: ScopeProfile[] = [];

  for (const item of value) {
    const record = asRecord(item);
    const worktree =
      typeof record?.worktree === 'string' && record.worktree.length > 0
        ? record.worktree
        : undefined;
    if (!worktree) continue;

    result.push({
      worktree,
      grep:
        record?.grep === undefined
          ? undefined
          : asScopeName(record.grep, DEFAULT_SCOPE_DEFAULTS.grep),
      describe:
        record?.describe === undefined
          ? undefined
          : asScopeName(record.describe, DEFAULT_SCOPE_DEFAULTS.describe),
    });
  }

  return result;
}

function asRetentionOptions(
  value: unknown,
  fallback: RetentionPolicyOptions,
): RetentionPolicyOptions {
  const record = asRecord(value);
  return {
    staleSessionDays:
      record?.staleSessionDays === undefined
        ? fallback.staleSessionDays
        : asOptionalNumber(record.staleSessionDays),
    deletedSessionDays:
      record?.deletedSessionDays === undefined
        ? fallback.deletedSessionDays
        : asOptionalNumber(record.deletedSessionDays),
    orphanBlobDays:
      record?.orphanBlobDays === undefined
        ? fallback.orphanBlobDays
        : asOptionalNumber(record.orphanBlobDays),
  };
}

function asPrivacyOptions(value: unknown, fallback: PrivacyOptions): PrivacyOptions {
  const record = asRecord(value);
  return {
    excludeToolPrefixes: asStringArray(record?.excludeToolPrefixes, fallback.excludeToolPrefixes),
    excludePathPatterns: asStringArray(record?.excludePathPatterns, fallback.excludePathPatterns),
    redactPatterns: asStringArray(record?.redactPatterns, fallback.redactPatterns),
  };
}

function asAutomaticRetrievalOptions(
  value: unknown,
  fallback: AutomaticRetrievalOptions,
): AutomaticRetrievalOptions {
  const record = asRecord(value);
  return {
    enabled: asBoolean(record?.enabled, fallback.enabled),
    maxChars: asNumber(record?.maxChars, fallback.maxChars),
    minTokens: asNumber(record?.minTokens, fallback.minTokens),
    maxMessageHits: asNumber(record?.maxMessageHits, fallback.maxMessageHits),
    maxSummaryHits: asNumber(record?.maxSummaryHits, fallback.maxSummaryHits),
    maxArtifactHits: asNumber(record?.maxArtifactHits, fallback.maxArtifactHits),
    scopeOrder: asScopeNameArray(record?.scopeOrder, fallback.scopeOrder),
    scopeBudgets: asAutomaticRetrievalScopeBudgets(record?.scopeBudgets, fallback.scopeBudgets),
    stop: asAutomaticRetrievalStopOptions(record?.stop, fallback.stop),
  };
}

function asAutomaticRetrievalScopeBudgets(
  value: unknown,
  fallback: AutomaticRetrievalScopeBudgets,
): AutomaticRetrievalScopeBudgets {
  const record = asRecord(value);
  return {
    session: asNonNegativeNumber(record?.session, fallback.session),
    root: asNonNegativeNumber(record?.root, fallback.root),
    worktree: asNonNegativeNumber(record?.worktree, fallback.worktree),
    all: asNonNegativeNumber(record?.all, fallback.all),
  };
}

function asAutomaticRetrievalStopOptions(
  value: unknown,
  fallback: AutomaticRetrievalStopOptions,
): AutomaticRetrievalStopOptions {
  const record = asRecord(value);
  return {
    targetHits: asNonNegativeNumber(record?.targetHits, fallback.targetHits),
    stopOnFirstScopeWithHits: asBoolean(
      record?.stopOnFirstScopeWithHits,
      fallback.stopOnFirstScopeWithHits,
    ),
  };
}

function asSummaryStrategy(value: unknown, fallback: SummaryStrategyName): SummaryStrategyName {
  return value === 'deterministic-v1' || value === 'deterministic-v2' || value === 'llm-cli'
    ? value
    : fallback;
}

function asSummaryV2Options(value: unknown, fallback: SummaryV2Options): SummaryV2Options {
  const record = asRecord(value);
  return {
    strategy: asSummaryStrategy(record?.strategy, fallback.strategy),
    maxChars: asNumber(record?.maxChars, fallback.maxChars),
    includeAllMessages: asBoolean(record?.includeAllMessages, fallback.includeAllMessages),
    perMessageBudget: asNumber(record?.perMessageBudget, fallback.perMessageBudget),
  };
}

function asLlmCliOptions(value: unknown, fallback: LlmCliOptions): LlmCliOptions {
  const record = asRecord(value);
  return {
    enabled: asBoolean(record?.enabled, fallback.enabled),
    command:
      typeof record?.command === 'string' && record.command.length > 0
        ? record.command
        : fallback.command,
    args: asStringArray(record?.args, fallback.args),
    model:
      typeof record?.model === 'string' && record.model.length > 0 ? record.model : fallback.model,
    promptMode:
      record?.promptMode === 'stdin'
        ? 'stdin'
        : record?.promptMode === 'arg'
          ? 'arg'
          : fallback.promptMode,
    timeoutMs: asNonNegativeNumber(record?.timeoutMs, fallback.timeoutMs),
    maxPromptChars: asNonNegativeNumber(record?.maxPromptChars, fallback.maxPromptChars),
    fallbackOnError: asBoolean(record?.fallbackOnError, fallback.fallbackOnError),
    asyncEnhancement: asBoolean(record?.asyncEnhancement, fallback.asyncEnhancement),
  };
}

export function resolveOptions(raw: unknown): OpencodeLcmOptions {
  const options = asRecord(raw);
  const interop = asRecord(options?.interop);
  const scopeDefaults = asScopeDefaults(options?.scopeDefaults, DEFAULT_SCOPE_DEFAULTS);

  return {
    interop: {
      contextMode: asBoolean(interop?.contextMode, DEFAULT_INTEROP.contextMode),
      neverOverrideCompactionPrompt: asBoolean(
        interop?.neverOverrideCompactionPrompt,
        DEFAULT_INTEROP.neverOverrideCompactionPrompt,
      ),
      ignoreToolPrefixes: asStringArray(
        interop?.ignoreToolPrefixes,
        DEFAULT_INTEROP.ignoreToolPrefixes,
      ),
    },
    scopeDefaults,
    scopeProfiles: asScopeProfiles(options?.scopeProfiles),
    retention: asRetentionOptions(options?.retention, DEFAULT_RETENTION),
    privacy: asPrivacyOptions(options?.privacy, DEFAULT_PRIVACY),
    automaticRetrieval: asAutomaticRetrievalOptions(
      options?.automaticRetrieval,
      DEFAULT_AUTOMATIC_RETRIEVAL,
    ),
    compactContextLimit: asNumber(
      options?.compactContextLimit,
      DEFAULT_OPTIONS.compactContextLimit,
    ),
    systemHint: asBoolean(options?.systemHint, DEFAULT_OPTIONS.systemHint),
    storeDir:
      typeof options?.storeDir === 'string' && options.storeDir.length > 0
        ? options.storeDir
        : undefined,
    freshTailMessages: asNumber(options?.freshTailMessages, DEFAULT_OPTIONS.freshTailMessages),
    minMessagesForTransform: asNumber(
      options?.minMessagesForTransform,
      DEFAULT_OPTIONS.minMessagesForTransform,
    ),
    summaryCharBudget: asNumber(options?.summaryCharBudget, DEFAULT_OPTIONS.summaryCharBudget),
    partCharBudget: asNumber(options?.partCharBudget, DEFAULT_OPTIONS.partCharBudget),
    largeContentThreshold: asNumber(
      options?.largeContentThreshold,
      DEFAULT_OPTIONS.largeContentThreshold,
    ),
    artifactPreviewChars: asNumber(
      options?.artifactPreviewChars,
      DEFAULT_OPTIONS.artifactPreviewChars,
    ),
    artifactViewChars: asNumber(options?.artifactViewChars, DEFAULT_OPTIONS.artifactViewChars),
    binaryPreviewProviders: asStringArray(
      options?.binaryPreviewProviders,
      DEFAULT_OPTIONS.binaryPreviewProviders,
    ),
    previewBytePeek: asNumber(options?.previewBytePeek, DEFAULT_OPTIONS.previewBytePeek),
    summaryV2: asSummaryV2Options(options?.summaryV2, DEFAULT_SUMMARY_V2),
    llmCli: asLlmCliOptions(options?.llmCli, DEFAULT_LLM_CLI),
  };
}

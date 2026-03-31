import type { ConversationMessage, SearchResult } from './types.js';
import { shortNodeID, truncate } from './utils.js';

export type AutomaticRetrievalHit = {
  kind: 'message' | 'summary' | 'artifact';
  id: string;
  label: string;
  sessionID?: string;
  snippet: string;
};

export type ArchiveSummaryRoot = {
  nodeID: string;
  summaryText: string;
};

export type ArchiveTransformWindow = {
  anchor: ConversationMessage;
  archived: ConversationMessage[];
  recent: ConversationMessage[];
  recentStart: number;
};

export type AutomaticRetrievalTelemetry = {
  queries: string[];
  rawResults: number;
  stopReason: string;
  scopeStats: Array<{
    scope: string;
    budget: number;
    rawResults: number;
    selectedHits: number;
  }>;
};

type AutomaticRetrievalQuotas = {
  message: number;
  summary: number;
  artifact: number;
};

export function resolveArchiveTransformWindow(
  messages: ConversationMessage[],
  freshTailMessages: number,
): ArchiveTransformWindow | undefined {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.info.role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return undefined;

  let recentStart = Math.max(0, messages.length - Math.max(0, freshTailMessages));
  if (latestUserIndex < recentStart) {
    recentStart = latestUserIndex;
  }
  if (recentStart <= 0) return undefined;

  return {
    anchor: messages[latestUserIndex],
    archived: messages.slice(0, recentStart),
    recent: messages.slice(recentStart),
    recentStart,
  };
}

export function selectAutomaticRetrievalHits(input: {
  recent: ConversationMessage[];
  tokens: string[];
  results: SearchResult[];
  quotas: AutomaticRetrievalQuotas;
  isFreshResult: (result: SearchResult, freshMessageIDs: Set<string>) => boolean;
}): AutomaticRetrievalHit[] {
  const freshMessageIDs = new Set(input.recent.map((message) => message.info.id));
  const quotas = { ...input.quotas };
  // With few tokens each one is critical — require at least 2 token matches when possible
  const minSnippetMatches = input.tokens.length >= 2 ? 2 : 1;
  const hits: AutomaticRetrievalHit[] = [];

  for (const result of input.results) {
    const kind =
      result.type === 'summary'
        ? 'summary'
        : result.type.startsWith('artifact:')
          ? 'artifact'
          : 'message';
    if (quotas[kind] <= 0) continue;
    if (input.isFreshResult(result, freshMessageIDs)) continue;

    const lowerSnippet = result.snippet.toLowerCase();
    const matchedTokens = input.tokens.filter((token) => lowerSnippet.includes(token)).length;
    if (matchedTokens < minSnippetMatches && input.tokens.length > 1) continue;

    hits.push({
      kind,
      id: result.id,
      label: result.type,
      sessionID: result.sessionID,
      snippet: result.snippet,
    });
    quotas[kind] -= 1;
    if (quotas.message <= 0 && quotas.summary <= 0 && quotas.artifact <= 0) break;
  }

  return hits;
}

export function renderAutomaticRetrievalContext(
  scopes: string | string[],
  hits: AutomaticRetrievalHit[],
  maxChars: number,
  telemetry?: AutomaticRetrievalTelemetry,
): string {
  const scopeLabel = Array.isArray(scopes) ? scopes.join(' -> ') : scopes;
  const selectedByKind = {
    message: hits.filter((hit) => hit.kind === 'message').length,
    summary: hits.filter((hit) => hit.kind === 'summary').length,
    artifact: hits.filter((hit) => hit.kind === 'artifact').length,
  };
  const lines = [
    '<system-reminder>',
    `opencode-lcm automatically recalled ${hits.length} archived context hit(s) relevant to the current turn (scope=${scopeLabel}).`,
    ...(telemetry
      ? [
          `Recall telemetry: queries=${telemetry.queries.join(' | ')}`,
          `Recall telemetry: raw_results=${telemetry.rawResults} selected_hits=${hits.length} message_hits=${selectedByKind.message} summary_hits=${selectedByKind.summary} artifact_hits=${selectedByKind.artifact}`,
          `Recall telemetry: stop_reason=${telemetry.stopReason}`,
          `Recall telemetry: scope_stats=${telemetry.scopeStats
            .map(
              (stat) =>
                `${stat.scope}:hits=${stat.selectedHits},raw=${stat.rawResults},budget=${stat.budget}`,
            )
            .join(' | ')}`,
        ]
      : []),
    'Recalled context:',
    ...hits.map((hit) => {
      const session = hit.sessionID ? ` session=${hit.sessionID}` : '';
      const id = hit.kind === 'summary' ? shortNodeID(hit.id) : hit.id;
      return `- ${hit.kind}${session} id=${id} (${hit.label}): ${truncate(hit.snippet, 220)}`;
    }),
    'Treat recalled archive as supporting context and prefer the currently visible conversation if details conflict.',
    '</system-reminder>',
  ];

  return truncate(lines.join('\n'), maxChars);
}

export function buildActiveSummaryText(
  roots: ArchiveSummaryRoot[],
  archivedCount: number,
  maxChars: number,
): string {
  const lines = [
    '<system-reminder>',
    `opencode-lcm compacted ${archivedCount} older conversation turns into ${roots.length} archived summary node(s).`,
    'Archived roots:',
    ...roots.map((node) => `- ${node.nodeID}: ${truncate(node.summaryText, 180)}`),
    'Use lcm_expand with a node ID if older details become relevant, then lcm_artifact for externalized payloads.',
    '</system-reminder>',
  ];

  return truncate(lines.join('\n'), maxChars);
}

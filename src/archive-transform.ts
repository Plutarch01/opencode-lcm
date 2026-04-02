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

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function formatAutomaticRetrievalHit(hit: AutomaticRetrievalHit): string {
  const session = hit.sessionID ? ` session=${hit.sessionID}` : '';
  const id = hit.kind === 'summary' ? shortNodeID(hit.id) : hit.id;
  const label = hit.label !== hit.kind ? ` (${hit.label})` : '';
  return `${hit.kind}${session} id=${id}${label}: ${truncate(hit.snippet, 180)}`;
}

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
  _telemetry?: AutomaticRetrievalTelemetry,
): string {
  const scopeLabel = Array.isArray(scopes) ? scopes.join(' -> ') : scopes;
  const lines = [
    `[Archived by opencode-lcm: recalled ${hits.length} archived ${pluralize(hits.length, 'hit')} for this turn (scope=${scopeLabel}).]`,
    `Archived hits: ${hits.map((hit) => formatAutomaticRetrievalHit(hit)).join(' | ')}`,
  ];

  return truncate(lines.join('\n'), maxChars);
}

export function buildActiveSummaryText(
  roots: ArchiveSummaryRoot[],
  archivedCount: number,
  maxChars: number,
): string {
  const lines = [
    `[Archived by opencode-lcm: compacted ${archivedCount} older conversation ${pluralize(archivedCount, 'turn')} into ${roots.length} archived summary ${pluralize(roots.length, 'node')}.]`,
    `Summary roots: ${roots.map((node) => `${node.nodeID}: ${truncate(node.summaryText, 140)}`).join(' | ')}`,
  ];

  return truncate(lines.join('\n'), maxChars);
}

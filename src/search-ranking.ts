import type { SearchResult } from "./types.js";

export type SearchCandidate = {
  id: string;
  type: string;
  sessionID?: string;
  timestamp: number;
  snippet: string;
  content: string;
  sourceKind: "message" | "summary" | "artifact";
  sourceOrder: number;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenizeQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])];
}

function buildRecencyRange(candidates: SearchCandidate[]): { oldest: number; newest: number } {
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    oldest = Math.min(oldest, candidate.timestamp);
    newest = Math.max(newest, candidate.timestamp);
  }

  if (!Number.isFinite(oldest) || !Number.isFinite(newest)) {
    return { oldest: 0, newest: 0 };
  }

  return { oldest, newest };
}

function scoreSearchCandidate(
  candidate: SearchCandidate,
  query: string,
  tokens: string[],
  recencyRange: { oldest: number; newest: number },
): number {
  const content = candidate.content.toLowerCase();
  const snippet = candidate.snippet.toLowerCase();
  const exactPhrase = content.includes(query);
  const base = candidate.sourceKind === "message" ? 135 : candidate.sourceKind === "artifact" ? 96 : 78;

  let matchedTokens = 0;
  let totalHits = 0;
  let boundaryHits = 0;

  for (const token of tokens) {
    const hasToken = content.includes(token);
    if (hasToken) matchedTokens += 1;

    const boundaryPattern = new RegExp(`\\b${escapeRegExp(token)}\\b`, "g");
    const matches = content.match(boundaryPattern)?.length ?? 0;
    boundaryHits += matches;
    totalHits += matches > 0 ? matches : hasToken ? 1 : 0;
  }

  const coverage = tokens.length > 0 ? matchedTokens / tokens.length : 0;
  let score = base;
  if (candidate.sourceKind === "message") {
    score += candidate.type === "user" ? 22 : candidate.type === "assistant" ? 12 : 0;
  }
  score += exactPhrase ? 90 : 0;
  score += coverage * 70;
  score += matchedTokens * 12;
  score += Math.min(totalHits, matchedTokens + 2) * 2;
  score += Math.min(boundaryHits, matchedTokens) * 4;
  score += snippet.includes(query) ? 24 : 0;
  score += Math.max(0, 18 - candidate.sourceOrder);
  if (recencyRange.newest > recencyRange.oldest) {
    const recencyRatio = (candidate.timestamp - recencyRange.oldest) / (recencyRange.newest - recencyRange.oldest);
    score += recencyRatio * 28;
  }
  return score;
}

export function rankSearchCandidates(candidates: SearchCandidate[], query: string, limit: number): SearchResult[] {
  const exactQuery = query.toLowerCase();
  const tokens = tokenizeQuery(query);
  const deduped = new Map<string, SearchCandidate & { score: number }>();
  const recencyRange = buildRecencyRange(candidates);

  for (const candidate of candidates) {
    const score = scoreSearchCandidate(candidate, exactQuery, tokens, recencyRange);
    const key = `${candidate.type}:${candidate.id}`;
    const existing = deduped.get(key);
    if (!existing || score > existing.score || (score === existing.score && candidate.timestamp > existing.timestamp)) {
      deduped.set(key, {
        ...candidate,
        score,
      });
    }
  }

  return [...deduped.values()]
    .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
    .slice(0, limit)
    .map(({ content: _content, sourceKind: _sourceKind, sourceOrder: _sourceOrder, score: _score, ...result }) => result);
}
